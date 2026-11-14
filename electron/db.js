const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  normalizeJid,
  isPnJid,
  isLidJid,
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
    this.contactIndex = new Map();
    this.contactIndexPositions = new WeakMap();
    this.contactIndexReady = false;
    this.contactIndexStats = {
      lookups: 0,
      hits: 0,
      misses: 0,
      keyChecks: 0,
      rebuilds: 0,
      rebuildMs: 0,
      contactsScanned: 0
    };
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
      try {
        if (fs.existsSync(this.filePath)) {
          const backup = `${this.filePath}.corrupt-${Date.now()}`;
          fs.renameSync(this.filePath, backup);
          console.error(`Preserved unreadable database at ${backup}`);
        }
      } catch (backupError) {
        console.error('Failed to preserve unreadable database:', backupError);
      }
      this.data = defaultData();
      this.save();
    }
    this.rebuildContactIndex();
    if (this.refreshCachedDisplayNames() > 0) this.save();
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
      lastActionAt: 0,
      adminAccess: {}
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

  rebuildContactIndex() {
    const startedAt = process.hrtime.bigint();
    this.contactIndex = new Map();
    this.contactIndexPositions = new WeakMap();
    const contacts = Array.isArray(this.data.contacts) ? this.data.contacts : [];
    for (let position = 0; position < contacts.length; position += 1) {
      const contact = contacts[position];
      if (!contact || typeof contact !== 'object') continue;
      this.contactIndexPositions.set(contact, position);
      for (const key of identityKeys(contact)) {
        if (!this.contactIndex.has(key)) {
          this.contactIndex.set(key, contact);
        }
      }
    }
    this.contactIndexReady = true;
    this.contactIndexStats.rebuilds += 1;
    this.contactIndexStats.rebuildMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  }

  ensureContactIndex() {
    if (!this.contactIndexReady) this.rebuildContactIndex();
  }

  indexContact(contact, position) {
    if (!contact || typeof contact !== 'object') return;
    if (!this.contactIndexPositions.has(contact)) {
      const resolvedPosition = typeof position === 'number'
        ? position
        : this.data.contacts.indexOf(contact);
      if (resolvedPosition >= 0) {
        this.contactIndexPositions.set(contact, resolvedPosition);
      }
    }
    for (const key of identityKeys(contact)) {
      if (!this.contactIndex.has(key)) {
        this.contactIndex.set(key, contact);
      }
    }
  }

  getContactIndexStats() {
    return {
      ...this.contactIndexStats,
      size: this.contactIndex.size,
      contacts: Array.isArray(this.data.contacts) ? this.data.contacts.length : 0,
      ready: this.contactIndexReady
    };
  }

  findContact(value) {
    this.ensureContactIndex();
    const keys = identityKeys(value);
    this.contactIndexStats.lookups += 1;
    if (!keys.size) {
      this.contactIndexStats.misses += 1;
      return null;
    }

    let match = null;
    let matchPosition = Infinity;
    for (const key of keys) {
      this.contactIndexStats.keyChecks += 1;
      const contact = this.contactIndex.get(key);
      if (!contact) continue;
      const position = this.contactIndexPositions.has(contact)
        ? this.contactIndexPositions.get(contact)
        : this.data.contacts.indexOf(contact);
      if (position >= 0 && position < matchPosition) {
        match = contact;
        matchPosition = position;
      }
    }

    if (match) {
      this.contactIndexStats.hits += 1;
      return match;
    }
    this.contactIndexStats.misses += 1;
    return null;
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
      this.indexContact(contact, this.data.contacts.length);
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
    this.indexContact(contact);
    return contact;
  }

  linkContactIdentities(identity, accountId) {
    this.ensureContactIndex();
    const normalized = participantIdentity(identity, identity);
    const keys = identityKeys(normalized);
    if (!keys.size) return { contact: null, changed: false };

    const matches = [];
    const seen = new Set();
    for (const key of keys) {
      const contact = this.contactIndex.get(key);
      if (contact && !seen.has(contact)) {
        seen.add(contact);
        matches.push(contact);
      }
    }

    if (matches.length === 0) {
      const contact = this.upsertContactIdentity(normalized, '', accountId, 'mapping', '');
      return { contact, changed: Boolean(contact) };
    }

    const positionOf = (contact) => (this.contactIndexPositions.has(contact)
      ? this.contactIndexPositions.get(contact)
      : this.data.contacts.indexOf(contact));
    matches.sort((first, second) => positionOf(first) - positionOf(second));
    const primary = matches[0];
    let changed = false;

    for (const duplicate of matches.slice(1)) {
      const primaryName = sanitizeContactName(primary.name);
      const duplicateName = sanitizeContactName(duplicate.name);
      const primaryPriority = NAME_SOURCE_PRIORITY[primary.nameSource] || (primaryName ? 1 : 0);
      const duplicatePriority = NAME_SOURCE_PRIORITY[duplicate.nameSource] || (duplicateName ? 1 : 0);
      const duplicateLid = isLidJid(duplicate.id) ? normalizeJid(duplicate.id) : '';
      const duplicateJid = isPnJid(duplicate.id) ? normalizeJid(duplicate.id) : '';
      mergeContactRecords(primary, duplicate);
      if (duplicateLid && !primary.lid) primary.lid = duplicateLid;
      if (duplicateJid && !primary.jid) primary.jid = duplicateJid;
      if (!sanitizeContactName(primary.localName) && sanitizeContactName(duplicate.localName)) {
        primary.localName = sanitizeContactName(duplicate.localName);
      }
      if (duplicateName && (!primaryName || duplicatePriority > primaryPriority)) {
        primary.name = duplicateName;
        primary.nameSource = duplicate.nameSource;
      }
      if (duplicate.lastSyncedAt && (!primary.lastSyncedAt || duplicate.lastSyncedAt > primary.lastSyncedAt)) {
        primary.lastSyncedAt = duplicate.lastSyncedAt;
      }
      const duplicatePosition = this.data.contacts.indexOf(duplicate);
      if (duplicatePosition >= 0) {
        this.data.contacts.splice(duplicatePosition, 1);
        changed = true;
      }
    }

    const keysBefore = identityKeys(primary);
    if (!primary.id) primary.id = normalized.id || '';
    if (!primary.jid && normalized.jid) primary.jid = normalized.jid;
    if (!primary.lid && normalized.lid) primary.lid = normalized.lid;
    if (!primary.phoneNumber && normalized.phoneNumber) primary.phoneNumber = normalized.phoneNumber;
    if (identityKeys(primary).size !== keysBefore.size) changed = true;
    if (!Array.isArray(primary.sourceAccounts)) primary.sourceAccounts = [];
    if (accountId && !primary.sourceAccounts.includes(accountId)) {
      primary.sourceAccounts.push(accountId);
      changed = true;
    }
    if (!Array.isArray(primary.sourceTypes)) primary.sourceTypes = [];
    if (!primary.sourceTypes.includes('mapping')) {
      primary.sourceTypes.push('mapping');
      changed = true;
    }
    if (changed) {
      primary.lastSyncedAt = new Date().toISOString();
      if (matches.length > 1) {
        this.rebuildContactIndex();
      } else {
        this.indexContact(primary);
      }
    }
    return { contact: primary, changed };
  }

  enrichMember(member) {
    if (!member || typeof member !== 'object') return member;
    const resolved = this.contactName(member);
    const fallback = sanitizeContactName(member.displayName) || sanitizeContactName(member.name);
    return { ...member, displayName: resolved || fallback || '' };
  }

  refreshCachedDisplayNames(changedContacts) {
    this.ensureContactIndex();
    const changedKeys = Array.isArray(changedContacts)
      ? new Set(changedContacts.flatMap((contact) => Array.from(identityKeys(contact))))
      : null;
    const matchesChangedContact = (value) => {
      if (!changedKeys) return true;
      if (changedKeys.size === 0) return false;
      for (const key of identityKeys(value)) {
        if (changedKeys.has(key)) return true;
      }
      return false;
    };
    let changed = 0;
    for (const group of this.data.groups || []) {
      for (const member of group.members || []) {
        if (!matchesChangedContact(member)) continue;
        const name = this.contactName(member);
        if (name && member.displayName !== name) {
          member.displayName = name;
          changed += 1;
        }
      }
    }
    for (const job of this.data.jobs || []) {
      for (const target of job.targets || []) {
        const value = target.jid || target.number || target.phoneNumber;
        if (!matchesChangedContact(value)) continue;
        const name = this.contactName(value);
        if (name && target.displayName !== name) {
          target.displayName = name;
          changed += 1;
        }
      }
    }
    return changed;
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
  account.adminAccess = account.adminAccess && typeof account.adminAccess === 'object' ? account.adminAccess : {};

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
    target.displayName = displayName || '';
  } else {
    target.phoneNumber = '';
    target.displayName = displayName || '';
  }
  target.name = sanitizeContactName(target.name) || displayName || '';
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
