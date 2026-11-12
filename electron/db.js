const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  normalizeJid,
  phoneDigits,
  phoneFromJid,
  jidFromPhone,
  formatPhone,
  participantIdentity,
  identityKeys,
  normalizeAdminId,
  sanitizeContactName,
  mergeContactRecords
} = require('./identity');

const NAME_SOURCE_PRIORITY = {
  local: 5,
  whatsapp: 4,
  participant: 3,
  notify: 2,
  verified: 1
};

const DEFAULT_SETTINGS = {
  dailyCap: 20,
  minDelaySeconds: 25,
  maxDelaySeconds: 90,
  batchSize: 5,
  batchPauseMinSeconds: 180,
  batchPauseMaxSeconds: 360,
  quietStart: '23:00',
  quietEnd: '07:00',
  failurePauseThreshold: 3,
  maxAccounts: 4
};

function defaultData() {
  return {
    version: 3,
    auth: null,
    settings: { ...DEFAULT_SETTINGS },
    accounts: [],
    groups: [],
    contacts: [],
    jobs: [],
    logs: []
  };
}

class Database {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = defaultData();
  }

  load() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.data = migrateData({
          ...defaultData(),
          ...parsed,
          settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
          accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
          groups: Array.isArray(parsed.groups) ? parsed.groups : [],
          contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [],
          jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
          logs: Array.isArray(parsed.logs) ? parsed.logs : []
        });
        this.save();
      } else {
        this.save();
      }
    } catch (error) {
      console.error('Failed to load local database:', error);
      this.data = defaultData();
    }
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      console.error('Failed to save local database:', error);
    }
  }

  todayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  resetDailyCounters() {
    const today = this.todayKey();
    let changed = false;
    for (const account of this.data.accounts) {
      if (account.dailyActionDate !== today) {
        account.dailyActionDate = today;
        account.dailyActionCount = 0;
        account.dailyActionLimit = this.data.settings.dailyCap;
        account.pausedForDay = null;
        account.consecutiveFailures = 0;
        account.batchCount = 0;
        account.batchPauseUntil = 0;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  addAccount(alias) {
    const id = `acc_${crypto.randomUUID()}`;
    const today = this.todayKey();
    const account = {
      id,
      alias,
      phoneNumber: '',
      whatsappId: '',
      whatsappJid: '',
      whatsappLid: '',
      authFolder: id,
      status: 'disconnected',
      dailyActionCount: 0,
      dailyActionDate: today,
      dailyActionLimit: this.data.settings.dailyCap,
      lastActiveAt: null,
      connectedAt: null,
      createdAt: new Date().toISOString(),
      needsRelink: false,
      pendingOnboarding: true,
      onboardingError: null,
      qr: null,
      consecutiveFailures: 0,
      pausedForDay: null,
      batchCount: 0,
      batchPauseUntil: 0,
      lastActionAt: 0
    };
    this.data.accounts.push(account);
    this.save();
    return account;
  }

  findAccount(id) {
    return this.data.accounts.find((account) => account.id === id);
  }

  findGroup(id) {
    return this.data.groups.find((group) => group.id === id);
  }

  findJob(id) {
    return this.data.jobs.find((job) => job.id === id);
  }

  addLog(entry) {
    this.data.logs.push({ ...entry, timestamp: entry.timestamp || new Date().toISOString() });
    if (this.data.logs.length > 5000) {
      this.data.logs.splice(0, this.data.logs.length - 5000);
    }
  }

  findContact(value) {
    const keys = identityKeys(value);
    if (!keys.size) return null;
    return this.data.contacts.find((contact) => {
      const contactKeys = identityKeys(contact);
      for (const key of contactKeys) {
        if (keys.has(key)) return true;
      }
      return false;
    }) || null;
  }

  upsertContact(phoneNumber, name, accountId) {
    return this.upsertContactIdentity({ phoneNumber }, name, accountId, 'manual', 'local');
  }

  upsertContactIdentity(identity, name, accountId, sourceType = 'group', nameSource = 'participant') {
    const normalized = participantIdentity(identity, identity);
    if (!normalized.id && !normalized.phoneNumber) return null;
    const cleanName = sanitizeContactName(name);
    const now = new Date().toISOString();
    let contact = this.findContact(normalized);
    if (!contact) {
      contact = {
        id: normalized.id || jidFromPhone(normalized.phoneNumber),
        jid: normalized.jid || '',
        lid: normalized.lid || '',
        phoneNumber: normalized.phoneNumber || '',
        name: cleanName,
        localName: nameSource === 'local' ? cleanName : '',
        nameSource: cleanName ? nameSource : '',
        sourceAccounts: accountId ? [accountId] : [],
        sourceTypes: sourceType ? [sourceType] : [],
        lastSyncedAt: now
      };
      this.data.contacts.push(contact);
      return contact;
    }

    if (!contact.id) contact.id = normalized.id || jidFromPhone(normalized.phoneNumber);
    if (!contact.jid && normalized.jid) contact.jid = normalized.jid;
    if (!contact.lid && normalized.lid) contact.lid = normalized.lid;
    if (!contact.phoneNumber && normalized.phoneNumber) contact.phoneNumber = normalized.phoneNumber;
    const currentName = sanitizeContactName(contact.name);
    const currentPriority = NAME_SOURCE_PRIORITY[contact.nameSource] || (currentName ? 1 : 0);
    const incomingPriority = NAME_SOURCE_PRIORITY[nameSource] || 0;
    if (cleanName && nameSource === 'local') {
      contact.localName = cleanName;
      if (!currentName || incomingPriority >= currentPriority) {
        contact.name = cleanName;
        contact.nameSource = 'local';
      }
    } else if (cleanName && (!currentName || incomingPriority > currentPriority)) {
      contact.name = cleanName;
      contact.nameSource = nameSource;
    }
    if (!Array.isArray(contact.sourceAccounts)) contact.sourceAccounts = [];
    if (accountId && !contact.sourceAccounts.includes(accountId)) {
      contact.sourceAccounts.push(accountId);
    }
    if (!Array.isArray(contact.sourceTypes)) contact.sourceTypes = [];
    if (sourceType && !contact.sourceTypes.includes(sourceType)) {
      contact.sourceTypes.push(sourceType);
    }
    contact.lastSyncedAt = now;
    return contact;
  }

  contactName(value) {
    const contact = this.findContact(value);
    if (!contact) return '';
    return sanitizeContactName(contact.localName) || sanitizeContactName(contact.name) || '';
  }
}

function mergeSourceTypes(target, source) {
  if (!Array.isArray(target.sourceTypes)) target.sourceTypes = [];
  for (const sourceType of source.sourceTypes || []) {
    if (sourceType && !target.sourceTypes.includes(sourceType)) target.sourceTypes.push(sourceType);
  }
}

function migrateAccount(account) {
  if (!account || typeof account !== 'object') return account;
  account.whatsappId = normalizeJid(account.whatsappId) || '';
  account.whatsappJid = normalizeJid(account.whatsappJid) || '';
  account.whatsappLid = normalizeJid(account.whatsappLid) || '';
  account.phoneNumber = phoneDigits(account.phoneNumber) || '';

  if (account.whatsappId) {
    if (!account.whatsappJid && account.whatsappId.endsWith('@s.whatsapp.net')) {
      account.whatsappJid = account.whatsappId;
    }
    if (!account.whatsappLid && account.whatsappId.endsWith('@lid')) {
      account.whatsappLid = account.whatsappId;
    }
  }
  if (!account.whatsappJid && account.phoneNumber) {
    account.whatsappJid = jidFromPhone(account.phoneNumber);
  }
  if (!account.whatsappId) {
    account.whatsappId = account.whatsappJid || account.whatsappLid;
  }
  if (!account.phoneNumber && account.whatsappJid) {
    account.phoneNumber = phoneFromJid(account.whatsappJid);
  }
  return account;
}

function migrateMember(member) {
  if (!member || typeof member !== 'object') return member;
  const identity = participantIdentity(member, member);
  member.id = identity.id;
  member.jid = identity.jid;
  member.lid = identity.lid;
  member.phoneNumber = identity.phoneNumber;
  member.displayName =
    sanitizeContactName(member.displayName) ||
    sanitizeContactName(member.name) ||
    sanitizeContactName(member.notify) ||
    '';
  member.isAdmin = Boolean(member.isAdmin);
  member.isSuperAdmin = Boolean(member.isSuperAdmin);
  member.joinedViaApp = member.joinedViaApp !== false;
  member.addedAt = member.addedAt || new Date().toISOString();
  return member;
}

function migrateGroup(group) {
  if (!group || typeof group !== 'object') return group;
  const members = Array.isArray(group.members) ? group.members.map(migrateMember) : [];
  const legacyAdminIds = [];
  const legacyAdminKeys = new Set();
  for (const raw of group.adminIds || []) {
    const adminId = normalizeAdminId(raw);
    if (!adminId) continue;
    legacyAdminIds.push(adminId);
    for (const key of identityKeys(adminId)) legacyAdminKeys.add(key);
  }

  for (const member of members) {
    if (member.isAdmin) continue;
    const keys = identityKeys(member);
    member.isAdmin = Array.from(keys).some((key) => legacyAdminKeys.has(key));
  }

  const adminIds = [];
  const seenAdminKeys = new Set();
  for (const member of members) {
    if (!member.isAdmin || !member.id) continue;
    const keys = identityKeys(member);
    if (Array.from(keys).some((key) => seenAdminKeys.has(key))) continue;
    adminIds.push(member.id);
    for (const key of keys) seenAdminKeys.add(key);
  }
  for (const adminId of legacyAdminIds) {
    const keys = identityKeys(adminId);
    if (Array.from(keys).some((key) => seenAdminKeys.has(key))) continue;
    adminIds.push(adminId);
    for (const key of keys) seenAdminKeys.add(key);
  }

  group.members = members;
  group.memberCount = members.length;
  group.adminIds = adminIds;
  group.adminAccountIds = Array.isArray(group.adminAccountIds) ? group.adminAccountIds : [];
  group.addressingMode = group.addressingMode === 'lid' ? 'lid' : group.addressingMode === 'pn' ? 'pn' : group.addressingMode;
  group.hasError = adminIds.length === 0 && !members.some((member) => member.isAdmin);
  return group;
}

function migrateContacts(contacts) {
  const migrated = [];
  const byKey = new Map();
  for (const raw of contacts || []) {
    if (!raw || typeof raw !== 'object') continue;
    const contact = { ...raw };
    const identity = participantIdentity(contact, contact);
    contact.id = identity.id || contact.id || '';
    contact.jid = identity.jid || '';
    contact.lid = identity.lid || '';
    contact.phoneNumber = identity.phoneNumber || phoneDigits(contact.phoneNumber) || '';
    contact.localName = sanitizeContactName(contact.localName) || '';
    contact.name = sanitizeContactName(contact.name) || '';
    contact.nameSource = contact.nameSource || (contact.name ? 'whatsapp' : '');
    if (!Array.isArray(contact.sourceTypes)) contact.sourceTypes = [];
    if (!contact.sourceTypes.length) contact.sourceTypes.push('group');
    if (!contact.id && contact.phoneNumber) contact.id = jidFromPhone(contact.phoneNumber);
    if (!contact.id) continue;

    const keys = identityKeys(contact);
    let existing = null;
    for (const key of keys) {
      if (byKey.has(key)) {
        existing = byKey.get(key);
        break;
      }
    }
    if (!existing) {
      existing = contact;
      migrated.push(existing);
    } else {
      const existingName = sanitizeContactName(existing.name);
      const incomingName = sanitizeContactName(contact.name);
      const existingPriority = NAME_SOURCE_PRIORITY[existing.nameSource] || (existingName ? 1 : 0);
      const incomingPriority = NAME_SOURCE_PRIORITY[contact.nameSource] || (incomingName ? 1 : 0);
      mergeContactRecords(existing, contact);
      mergeSourceTypes(existing, contact);
      if (incomingName && (!existingName || incomingPriority > existingPriority)) {
        existing.name = incomingName;
        existing.nameSource = contact.nameSource;
      }
    }
    for (const key of identityKeys(existing)) byKey.set(key, existing);
  }
  return migrated;
}

function migrateTarget(target) {
  if (!target || typeof target !== 'object') return target;
  const raw = target.jid || target.number || '';
  const jid = String(raw).includes('@') ? normalizeJid(raw) : '';
  if (jid) target.jid = jid;
  const phoneNumber = phoneDigits(target.phoneNumber) || phoneFromJid(jid) || phoneDigits(raw);
  const displayName = sanitizeContactName(target.displayName) || sanitizeContactName(target.name);
  if (phoneNumber) {
    target.phoneNumber = phoneNumber;
    target.number = phoneNumber;
    target.displayName = displayName || formatPhone(phoneNumber);
  } else if (jid) {
    target.phoneNumber = '';
    target.number = jid;
    target.displayName = displayName || 'Unknown contact';
  } else {
    target.phoneNumber = '';
    target.displayName = displayName || '';
  }
  return target;
}

function migrateData(data) {
  if (!data || typeof data !== 'object') return data;
  data.version = Math.max(3, Number(data.version) || 1);
  data.accounts = Array.isArray(data.accounts) ? data.accounts.map(migrateAccount) : [];
  data.groups = Array.isArray(data.groups) ? data.groups.map(migrateGroup) : [];
  data.contacts = migrateContacts(data.contacts);
  data.jobs = Array.isArray(data.jobs)
    ? data.jobs.map((job) => ({
      ...job,
      targets: Array.isArray(job.targets) ? job.targets.map(migrateTarget) : []
    }))
    : [];
  return data;
}

module.exports = { Database, DEFAULT_SETTINGS, migrateData };
