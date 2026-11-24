const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const secureFs = require('./secure-fs');
const { ensurePrivateDir, writeFileAtomicPrivate } = secureFs;
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

const DB_FORMAT = 'wgm-encrypted-db';
const DB_VERSION = 2;
const DB_AAD = Buffer.from('wgm-db-v2', 'utf8');
const MAX_DB_BYTES = 256 * 1024 * 1024;
const SAFE_ACCOUNT_ID = /^acc_[A-Za-z0-9-]{1,64}$/;

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
  maxAccounts: 4,
  autoLockMinutes: 15
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
    logs: [],
    security: {
      sessionMasterKey: ''
    }
  };
}

function normalizeLoadedData(parsed) {
  return migrateData({
    ...defaultData(),
    ...parsed,
    settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
    accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
    contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [],
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    logs: Array.isArray(parsed.logs) ? parsed.logs : []
  });
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('The encrypted database envelope is invalid.');
  }
  if (envelope.format !== DB_FORMAT || Number(envelope.version) !== DB_VERSION) {
    throw new Error('The encrypted database envelope has an unsupported format or version.');
  }
  if (envelope.cipher !== 'aes-256-gcm') {
    throw new Error('The encrypted database uses an unsupported cipher.');
  }
  if (typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.data !== 'string') {
    throw new Error('The encrypted database envelope is incomplete.');
  }
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const data = Buffer.from(envelope.data, 'base64');
  if (iv.length !== 12 || tag.length !== 16 || data.length === 0) {
    throw new Error('The encrypted database envelope is malformed.');
  }
  return { iv, tag, data };
}

function encryptDatabase(data, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid database encryption key.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(DB_AAD);
  const plaintext = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: DB_FORMAT,
    version: DB_VERSION,
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptDatabase(envelope, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid database encryption key.');
  const { iv, tag, data } = validateEnvelope(envelope);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(DB_AAD);
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (error) {
    const failure = new Error('The encrypted database could not be opened with this key.');
    failure.code = 'db_decrypt_failed';
    throw failure;
  }
  let parsed;
  try {
    parsed = JSON.parse(plaintext);
  } catch (error) {
    const failure = new Error('The decrypted database is not valid JSON.');
    failure.code = 'db_corrupt';
    throw failure;
  }
  return normalizeLoadedData(parsed);
}

class Database {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.fsOptions = { root: options.root ? path.resolve(options.root) : path.dirname(filePath) };
    this.io = {
      ensurePrivateDir: (dir, ioOptions = {}) =>
        (options.ensurePrivateDir || ensurePrivateDir)(dir, { ...this.fsOptions, ...ioOptions }),
      writeFileAtomicPrivate: (target, data, encoding = 'utf8', ioOptions = {}) =>
        (options.writeFileAtomicPrivate || writeFileAtomicPrivate)(target, data, encoding, {
          ...this.fsOptions,
          ...ioOptions
        }),
      readFileSync: options.readFileSync || fs.readFileSync
    };
    this.persistenceErrorHandler = options.onPersistenceError || null;
    this.lastPersistenceError = null;
    this.data = defaultData();
    this.mode = 'locked';
    this.encryptionKey = null;
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

  inspect() {
    this.io.ensurePrivateDir(path.dirname(this.filePath));
    if (!fs.existsSync(this.filePath)) return { kind: 'missing' };
    const stat = fs.lstatSync(this.filePath);
    if (stat.isSymbolicLink()) {
      const error = new Error('The local database path is a symbolic link.');
      error.code = 'db_unsafe_path';
      throw error;
    }
    if (!stat.isFile()) {
      const error = new Error('The local database path is not a regular file.');
      error.code = 'db_unsafe_path';
      throw error;
    }
    if (stat.size > MAX_DB_BYTES) throw new Error('The local database file is too large.');
    const parsed = JSON.parse(this.io.readFileSync(this.filePath, 'utf8'));
    if (parsed && parsed.format === DB_FORMAT) {
      try {
        validateEnvelope(parsed);
      } catch (error) {
        error.code = 'db_corrupt';
        throw error;
      }
      return { kind: 'encrypted', envelope: parsed };
    }
    return { kind: 'legacy', data: normalizeLoadedData(parsed) };
  }

  load() {
    this.io.ensurePrivateDir(path.dirname(this.filePath));
    if (!fs.existsSync(this.filePath)) {
      this.data = defaultData();
      this.mode = 'plaintext';
      this.saveOrThrow();
      this.rebuildContactIndex();
      return this.data;
    }
    let info;
    try {
      info = this.inspect();
    } catch (error) {
      console.error('Failed to load local database.');
      if (error.code === 'db_corrupt' || error.code === 'db_unsafe_path') throw error;
      if (error && ['EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EMFILE', 'ENFILE', 'EISDIR'].includes(error.code)) {
        throw error;
      }
      try {
        if (fs.existsSync(this.filePath)) {
          const backup = `${this.filePath}.corrupt-${Date.now()}`;
          fs.renameSync(this.filePath, backup);
          console.error(`Preserved unreadable database at ${backup}`);
        }
      } catch (backupError) {
        console.error('Failed to preserve unreadable database.');
      }
      const failure = new Error('The local database is unreadable and was not replaced.');
      failure.code = 'db_corrupt';
      throw failure;
    }
    if (info.kind === 'encrypted') {
      throw new Error('The local database is encrypted. Unlock it with the local security vault.');
    }
    this.data = info.data;
    this.mode = 'plaintext';
    this.saveOrThrow();
    this.rebuildContactIndex();
    if (this.refreshCachedDisplayNames() > 0) this.saveOrThrow();
    return this.data;
  }

  unlock(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid database encryption key.');
    const info = this.inspect();
    if (info.kind !== 'encrypted') {
      throw new Error('The local database is not encrypted.');
    }
    this.data = decryptDatabase(info.envelope, key);
    this.encryptionKey = Buffer.from(key);
    this.mode = 'encrypted';
    this.ensureSessionMasterKey();
    this.rebuildContactIndex();
    if (this.refreshCachedDisplayNames() > 0) this.saveOrThrow();
    return this.data;
  }

  useEncryptedData(data, key, options = {}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid database encryption key.');
    this.data = normalizeLoadedData(data || {});
    this.encryptionKey = Buffer.from(key);
    this.mode = 'encrypted';
    this.ensureSessionMasterKey();
    this.rebuildContactIndex();
    if (options.save !== false) this.saveOrThrow();
    return this.data;
  }

  ensureSessionMasterKey() {
    if (!this.data.security || typeof this.data.security !== 'object') this.data.security = {};
    if (!this.data.security.sessionMasterKey) {
      this.data.security.sessionMasterKey = crypto.randomBytes(32).toString('base64');
      this.saveOrThrow();
    }
    return this.data.security.sessionMasterKey;
  }

  setPersistenceErrorHandler(handler) {
    this.persistenceErrorHandler = typeof handler === 'function' ? handler : null;
  }

  reportPersistenceError(error, context) {
    if (this.persistenceErrorHandler) {
      try {
        this.persistenceErrorHandler(error, context || 'database');
      } catch (handlerError) {
        console.error('Persistence error handler failed.');
      }
    }
  }

  persistenceFailure(cause) {
    const error = new Error('The local database could not be saved to disk.');
    error.code = 'db_persist_failed';
    error.cause = cause;
    return error;
  }

  saveOrThrow() {
    if (this.mode === 'locked') {
      const error = new Error('The local database is locked.');
      error.code = 'db_locked';
      throw error;
    }
    try {
      this.io.ensurePrivateDir(path.dirname(this.filePath));
      if (this.mode === 'encrypted') {
        if (!this.encryptionKey) throw new Error('The database is unlocked without an encryption key.');
        this.io.writeFileAtomicPrivate(
          this.filePath,
          JSON.stringify(encryptDatabase(this.data, this.encryptionKey), null, 2)
        );
      } else {
        this.io.writeFileAtomicPrivate(this.filePath, JSON.stringify(this.data, null, 2));
      }
      this.lastPersistenceError = null;
      return true;
    } catch (error) {
      const failure = this.persistenceFailure(error);
      this.lastPersistenceError = failure;
      console.error('Failed to save local database.');
      throw failure;
    }
  }

  hasPersistenceError() {
    return Boolean(this.lastPersistenceError);
  }

  saveBestEffort(context = 'database') {
    try {
      this.saveOrThrow();
      return true;
    } catch (error) {
      this.reportPersistenceError(error, context);
      return false;
    }
  }

  transaction(mutator, context = 'database') {
    if (typeof mutator !== 'function') throw new Error('A transaction mutator is required.');
    const snapshot = structuredClone(this.data);
    try {
      const result = mutator(this.data);
      if (result && typeof result.then === 'function') {
        throw new Error('Database transactions must be synchronous.');
      }
      this.saveOrThrow();
      return result;
    } catch (error) {
      this.data = snapshot;
      this.rebuildContactIndex();
      if (error && error.code === 'db_persist_failed') this.reportPersistenceError(error, context);
      throw error;
    }
  }

  lock() {
    if (this.encryptionKey) {
      this.encryptionKey.fill(0);
      this.encryptionKey = null;
    }
    this.mode = 'locked';
    this.data = defaultData();
    this.contactIndex = new Map();
    this.contactIndexPositions = new WeakMap();
    this.contactIndexReady = false;
  }

  save() {
    if (this.mode === 'locked') return false;
    return this.saveBestEffort('database');
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
    if (changed) this.saveBestEffort('daily-counters');
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
    try {
      this.saveOrThrow();
    } catch (error) {
      this.data.accounts.pop();
      throw error;
    }
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
  const accountId = String(account.id || '');
  if (!account.authFolder) {
    account.authFolder = accountId;
  } else if (account.authFolder !== accountId || !SAFE_ACCOUNT_ID.test(String(account.authFolder))) {
    account.authFolder = accountId;
    account.needsRelink = true;
    account.lastError = 'The stored session folder was reset for security. Re-link this account.';
  }

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
  if (!data.security || typeof data.security !== 'object') data.security = { sessionMasterKey: '' };
  if (typeof data.security.sessionMasterKey !== 'string') data.security.sessionMasterKey = '';
  return data;
}

module.exports = {
  Database,
  DEFAULT_SETTINGS,
  migrateData,
  encryptDatabase,
  decryptDatabase,
  DB_FORMAT,
  DB_VERSION
};
