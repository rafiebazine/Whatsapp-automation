const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');
const pino = require('pino');
const QRCode = require('qrcode');
const { loadBaileys } = require('./baileys-loader');
const { useEncryptedAuthState } = require('./auth-store');
const {
  normalizeJid,
  isPnJid,
  isLidJid,
  phoneDigits,
  phoneFromJid,
  jidFromPhone,
  normalizePhone,
  parsePhoneNumber,
  formatPhone,
  participantIdentity,
  identityKeys,
  identityMatches,
  participantIsAdmin,
  participantIsSuperAdmin,
  normalizeAdminId,
  accountIsAdminOfGroup,
  preferredAccountJid,
  identitySummary,
  sanitizeContactName,
  getContactDisplayName
} = require('./identity');
const contactDiagnostics = require('./contact-diagnostics');

const logger = pino({ level: process.env.WGM_LOG_LEVEL || 'silent' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CONTACT_SYNC_BATCH_SIZE = 250;
const APP_STATE_CONTACT_COLLECTION = 'critical_unblock_low';
const HISTORY_SYNC_INITIAL_BOOTSTRAP = 0;
const HISTORY_SYNC_RECENT = 3;
const HISTORY_SYNC_PUSH_NAME = 4;
const ALLOWED_HISTORY_SYNC_TYPES = new Set([
  HISTORY_SYNC_INITIAL_BOOTSTRAP,
  HISTORY_SYNC_RECENT,
  HISTORY_SYNC_PUSH_NAME
]);

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function shouldProcessHistorySync(message) {
  contactDiagnostics.recordHistoryPredicate(message);
  return Boolean(message && ALLOWED_HISTORY_SYNC_TYPES.has(message.syncType));
}

function logRawGroupParticipants(source, metadata) {
  if (process.env.WGM_DIAGNOSTIC_PARTICIPANTS !== '1') return;
  const groupId = metadata && metadata.id;
  const participants = metadata && metadata.participants;
  console.log(
    `[GROUP PARTICIPANTS RAW] ${source} ${groupId || ''}`,
    JSON.stringify(participants, null, 2)
  );
}

function contactNameDetails(contact, fallbackSource) {
  const name = sanitizeContactName(contact.name)
    || sanitizeContactName(contact.notify)
    || sanitizeContactName(contact.verifiedName);
  const nameSource = sanitizeContactName(contact.name)
    ? 'whatsapp'
    : sanitizeContactName(contact.notify)
      ? 'notify'
      : sanitizeContactName(contact.verifiedName)
        ? 'verified'
        : '';
  return { name, nameSource: nameSource || fallbackSource };
}

function targetLabel(target) {
  if (target === null || target === undefined) return '';
  if (typeof target === 'string') return target;
  return target.displayName || target.name || formatPhone(target.phoneNumber) || target.number || target.jid || target.id || '';
}

function redactIdentityText(value) {
  return String(value || '')
    .replace(/[\w:.-]+@lid\b/gi, 'contact')
    .replace(/[\w:.-]+@s\.whatsapp\.net\b/gi, 'contact');
}

function friendlyError(error) {
  const text = redactIdentityText((error && (error.message || error.toString())) || 'Unknown error');
  const lowered = text.toLowerCase();
  if (lowered.includes('timed out')) return 'WhatsApp did not respond in time. Please try again.';
  if (lowered.includes('connection closed')) return 'The WhatsApp connection closed. Reconnecting…';
  if (lowered.includes('not-authorized') || lowered.includes('unauthorized')) return 'This account is not authorized. Please re-link it.';
  if (lowered.includes('rate-overlimit')) return 'WhatsApp rate limit reached. Actions will pause briefly.';
  if (lowered.includes('forbidden')) return 'Permission denied by WhatsApp for this action.';
  if (lowered.includes('not found')) return 'The group or contact could not be found.';
  return text.replace(/^Error:\s*/, '');
}

function statusCodeOf(error) {
  try {
    return error.output.statusCode;
  } catch (err) {
    return undefined;
  }
}

function actionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class SessionManager extends EventEmitter {
  constructor({ db, sessionsRoot }) {
    super();
    this.db = db;
    this.sessionsRoot = sessionsRoot;
    this.masterKey = null;
    this.sockets = new Map();
    this.reconnectTimers = new Map();
    this.reconnectAttempts = new Map();
    this.manualStops = new Set();
    this.onboarding = new Set();
    this.stopping = false;
    this.contactSyncBatchSize = CONTACT_SYNC_BATCH_SIZE;
    this.contactIngestChains = new Map();
    this.lastContactSyncStats = null;
    this.lastContactIngestStats = null;
    this.lastAppStateResyncStats = null;
    this.appStateForcedSnapshots = new Set();
  }

  setMasterKey(key) {
    this.masterKey = key;
  }

  hasMasterKey() {
    return Boolean(this.masterKey);
  }

  async startAll() {
    this.stopping = false;
    for (const account of this.db.data.accounts) {
      if (account.status === 'banned' || account.needsRelink) continue;
      this.startAccount(account.id).catch((error) => {
        console.error(`Failed to start account ${account.alias}:`, error);
      });
    }
  }

  async stopAll() {
    this.stopping = true;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const accountId of Array.from(this.sockets.keys())) {
      await this.stopAccount(accountId);
    }
    this.emit('accounts:update');
  }

  isConnected(accountId) {
    const entry = this.sockets.get(accountId);
    return Boolean(entry && entry.connected);
  }

  updateAccountIdentity(account, user) {
    if (!account || !user) return false;
    const identity = participantIdentity(user, {});
    let changed = false;

    if (identity.id && account.whatsappId !== identity.id) {
      account.whatsappId = identity.id;
      changed = true;
    }
    if (identity.jid && account.whatsappJid !== identity.jid) {
      account.whatsappJid = identity.jid;
      changed = true;
    }
    if (identity.lid && account.whatsappLid !== identity.lid) {
      account.whatsappLid = identity.lid;
      changed = true;
    }
    const phone = identity.phoneNumber || phoneFromJid(account.whatsappJid);
    if (phone && account.phoneNumber !== phone) {
      account.phoneNumber = phone;
      changed = true;
    }
    if (changed) {
      console.info('[identity] account identity updated', identitySummary(account));
    }
    return changed;
  }

  isAdminOf(account, group) {
    return accountIsAdminOfGroup(account, group);
  }

  isVerifiedAdminOf(account, group) {
    if (!account || !group || !group.id) return false;
    const access = account.adminAccess && account.adminAccess[group.id];
    return Boolean(access && access.status === 'verified');
  }

  setAdminAccess(account, groupId, status, error) {
    if (!account || !groupId) return;
    if (!account.adminAccess || typeof account.adminAccess !== 'object') account.adminAccess = {};
    account.adminAccess[groupId] = {
      status,
      checkedAt: new Date().toISOString(),
      error: error ? friendlyError(error) : ''
    };
  }

  recordAdminAccess(account, group, metadata) {
    if (!account || !group || !group.id) return 'unknown';
    const participants = (metadata && metadata.participants) || [];
    const participant = participants.find((item) => identityMatches(item, account));
    const status = participant
      ? (participantIsAdmin(participant) ? 'verified' : 'not_admin')
      : 'not_member';
    this.setAdminAccess(account, group.id, status, '');
    return status;
  }

  invalidateAdminAccess(account, reason) {
    if (!account) return;
    if (!account.adminAccess || typeof account.adminAccess !== 'object') account.adminAccess = {};
    const now = new Date().toISOString();
    for (const group of this.db.data.groups) {
      account.adminAccess[group.id] = {
        status: 'unknown',
        checkedAt: now,
        error: reason || 'Waiting for fresh admin verification.'
      };
    }
  }

  async verifyAdminAccess(accountId, groupId) {
    const account = this.db.findAccount(accountId);
    const entry = this.sockets.get(accountId);
    const group = this.db.findGroup(groupId);
    if (!account) return { status: 'unknown', error: 'Account not found.' };
    if (!group) return { status: 'unknown', error: 'Group not found.' };
    if (!entry || !entry.connected) {
      this.setAdminAccess(account, groupId, 'unknown', 'Account is disconnected.');
      this.db.save();
      this.emit('accounts:update');
      return { status: 'unknown', error: 'Account is disconnected.' };
    }

    let metadata;
    try {
      metadata = await entry.sock.groupMetadata(groupId);
    } catch (error) {
      const message = friendlyError(error);
      this.setAdminAccess(account, groupId, 'unknown', message);
      group.adminAccountIds = (group.adminAccountIds || []).filter((id) => id !== account.id);
      this.db.save();
      this.emit('accounts:update');
      this.emit('groups:update');
      return { status: 'unknown', error: message };
    }

    logRawGroupParticipants('groupMetadata', metadata);
    this.applyMetadataToGroup(group, metadata, account, true);
    const status = this.recordAdminAccess(account, group, metadata);
    this.db.save();
    this.emit('accounts:update');
    this.emit('groups:update');
    return {
      status,
      error: status === 'verified' ? '' : 'This account is not a verified admin of this group.',
      group,
      metadata
    };
  }

  async refreshAdminAccess(accountId) {
    const account = this.db.findAccount(accountId);
    const entry = this.sockets.get(accountId);
    if (!account || !entry || !entry.connected) return;

    let groups;
    try {
      groups = await entry.sock.groupFetchAllParticipating();
      if (!groups || typeof groups !== 'object') throw new Error('WhatsApp returned no group data.');
    } catch (error) {
      const message = friendlyError(error);
      for (const group of this.db.data.groups) {
        this.setAdminAccess(account, group.id, 'unknown', message);
      }
      this.db.save();
      this.emit('accounts:update');
      return;
    }

    for (const group of this.db.data.groups) {
      const metadata = groups[group.id];
      if (metadata) {
        logRawGroupParticipants('groupFetchAllParticipating', metadata);
        this.applyMetadataToGroup(group, metadata, account, true);
        this.recordAdminAccess(account, group, metadata);
      } else {
        this.setAdminAccess(account, group.id, 'not_member', '');
        group.adminAccountIds = (group.adminAccountIds || []).filter((id) => id !== account.id);
        group.hasError = (group.adminIds || []).length === 0;
      }
    }
    this.db.save();
    this.emit('accounts:update');
    this.emit('groups:update');
  }

  async startAccount(accountId) {
    if (this.stopping) return;
    const account = this.db.findAccount(accountId);
    if (!account) return;
    if (account.status === 'banned' || account.needsRelink) return;
    if (!this.masterKey) throw new Error('Login is required before starting WhatsApp sessions.');
    if (this.sockets.has(accountId)) return;

    const existingTimer = this.reconnectTimers.get(accountId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.reconnectTimers.delete(accountId);
    }

    const folder = path.join(this.sessionsRoot, account.authFolder);
    let authState;
    try {
      authState = await useEncryptedAuthState(folder, this.masterKey, account.id);
    } catch (error) {
      account.status = 'banned';
      account.needsRelink = true;
      account.lastError = `Could not decrypt session data: ${error.message}`;
      this.db.save();
      this.emit('accounts:update');
      throw error;
    }

    const baileys = await loadBaileys();
    const makeWASocket = baileys.default;
    const {
      fetchLatestBaileysVersion,
      DisconnectReason,
      Browsers,
      ALL_WA_PATCH_NAMES
    } = baileys;

    let version;
    try {
      version = await Promise.race([
        fetchLatestBaileysVersion().then((result) => result.version),
        sleep(7000).then(() => undefined)
      ]);
    } catch (error) {
      version = undefined;
    }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: authState.state,
      logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: shouldProcessHistorySync,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 2000,
      getMessage: async () => undefined
    });

    const entry = {
      sock,
      connected: false,
      saveCreds: authState.saveCreds,
      syncing: false,
      authKeys: authState.state.keys,
      appStatePatchNames: ALL_WA_PATCH_NAMES,
      appStateResyncStarted: false,
      appStateResyncPromise: null,
      appStateResyncStatus: 'pending',
      appStateResyncStartedAt: null,
      appStateResyncCompletedAt: null,
      appStateResyncError: '',
      appStateResyncEvents: 0,
      appStateResyncContacts: 0,
      appStateResyncNamedContacts: 0,
      appStateResyncIdentities: new Set(),
      appStateResyncForcedSnapshot: false
    };
    this.sockets.set(accountId, entry);
    this.manualStops.delete(accountId);

    sock.ev.on('creds.update', async (update) => {
      try {
        await authState.saveCreds();
        const me = (update && update.me) || sock.user;
        if (this.updateAccountIdentity(account, me)) {
          this.db.save();
          this.emit('accounts:update');
        }
      } catch (error) {
        console.error('Failed saving credentials:', error);
      }
    });

    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          try {
            account.qr = await QRCode.toDataURL(qr, {
              margin: 1,
              width: 360,
              color: { dark: '#111B21', light: '#FFFFFF' }
            });
            account.status = 'disconnected';
            this.emit('qr:update', {
              accountId: account.id,
              alias: account.alias,
              qr: account.qr
            });
            this.emit('accounts:update');
          } catch (error) {
            console.error('Failed to render QR:', error);
          }
        }

        if (connection === 'open') {
          entry.connected = true;
          account.qr = null;
          account.needsRelink = false;
          account.connectedAt = new Date().toISOString();
          account.lastActiveAt = new Date().toISOString();
          if (sock.user && sock.user.id) {
            this.updateAccountIdentity(account, sock.user);
          }
          const autoPaused = account.pausedForDay && account.pausedForDay === this.db.todayKey();
          account.status = autoPaused ? 'paused' : 'connected';
          account.lastError = null;
          this.reconnectAttempts.set(account.id, 0);
          this.db.save();
          this.invalidateAdminAccess(account, 'Waiting for fresh admin verification.');
          this.db.save();
          this.emit('accounts:update');
          this.emit('connection:open', { accountId: account.id });
          this.syncContacts(account.id).catch(() => {});
          this.refreshAdminAccess(account.id).catch(() => {});
          this.resyncAccountAppState(account.id).catch((error) => {
            console.error('[APP-STATE] Resync invocation failed', {
              accountId: account.id,
              error: error && error.message ? error.message : String(error)
            });
          });
          if (account.pendingOnboarding) {
            this.onboardAccount(account.id).catch(() => {});
          }
        }

        if (connection === 'close') {
          entry.connected = false;
          this.invalidateAdminAccess(account, 'Account disconnected.');
          const statusCode = statusCodeOf(lastDisconnect && lastDisconnect.error);
          if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403) {
            account.status = 'banned';
            account.needsRelink = true;
            account.lastError = 'This account was unlinked from WhatsApp. Re-link it to continue.';
            account.qr = null;
            this.db.save();
            this.emit('accounts:update');
            this.emit('toast', {
              type: 'error',
              message: `${account.alias} was logged out of WhatsApp. Re-link the account in Settings.`
            });
            this.sockets.delete(accountId);
            try {
              sock.end(undefined);
            } catch (error) {
              console.error(error);
            }
            return;
          }

          account.status = account.pausedForDay === this.db.todayKey() ? 'paused' : 'disconnected';
          this.db.save();
          this.emit('accounts:update');
          this.sockets.delete(accountId);
          this.scheduleReconnect(account.id);
        }
      } catch (error) {
        console.error('connection.update handler failed:', error);
      }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      this.handleContactsUpsert(account.id, contacts);
    });

    sock.ev.on('contacts.update', (contacts) => {
      contactDiagnostics.recordContactBatch('contacts.update', contacts, this.db);
      this.ingestContacts(account.id, contacts, { event: 'contacts.update' });
    });

    sock.ev.on('messaging-history.set', (data) => {
      contactDiagnostics.recordHistory(data);
      this.ingestHistory(account.id, data);
    });

    sock.ev.on('chats.upsert', (chats) => {
      this.ingestChats(account.id, chats, 'chats.upsert');
    });

    sock.ev.on('chats.update', (chats) => {
      this.ingestChats(account.id, chats, 'chats.update');
    });

    sock.ev.on('chats.phoneNumberShare', (share) => {
      this.linkContactIdentities(account.id, share);
    });

    sock.ev.on('messages.upsert', (event) => {
      contactDiagnostics.recordMessages(account.id, event, this.db);
    });

    sock.ev.on('groups.update', (updates) => {
      try {
        let changed = false;
        for (const update of updates || []) {
          const group = this.db.findGroup(update.id);
          if (!group) continue;
          if (update.subject && update.subject !== group.name) {
            group.name = update.subject;
            changed = true;
          }
          if (update.desc !== undefined) group.description = update.desc || '';
          if (changed) group.lastSyncedAt = new Date().toISOString();
        }
        if (changed) {
          this.db.save();
          this.emit('groups:update');
        }
      } catch (error) {
        console.error('groups.update handler failed:', error);
      }
    });

    sock.ev.on('group-participants.update', (event) => {
      try {
        const group = this.db.findGroup(event.id);
        if (!group) return;
        const changed = (event.participants || [])
          .map((jid) => participantIdentity({ id: jid }, { id: jid }))
          .filter((identity) => identity.id);

        if (event.action === 'add') {
          for (const identity of changed) {
            const existing = group.members.find((member) => identityMatches(member, identity));
            if (!existing) {
              group.members.push({
                ...identity,
                displayName: this.db.contactName(identity),
                isAdmin: false,
                isSuperAdmin: false,
                joinedViaApp: false,
                addedAt: new Date().toISOString()
              });
            }
          }
        }
        if (event.action === 'remove') {
          group.members = group.members.filter(
            (member) => !changed.some((identity) => identityMatches(member, identity))
          );
          group.adminIds = (group.adminIds || []).filter(
            (adminId) => !changed.some((identity) => identityMatches(adminId, identity))
          );
        }
        if (event.action === 'promote') {
          for (const identity of changed) {
            if (!group.adminIds.some((adminId) => identityMatches(adminId, identity))) {
              group.adminIds.push(identity.id);
            }
            const member = group.members.find((item) => identityMatches(item, identity));
            if (member) member.isAdmin = true;
            const linked = this.db.data.accounts.find((item) => identityMatches(item, identity));
            if (linked) {
              if (!Array.isArray(group.adminAccountIds)) group.adminAccountIds = [];
              if (!group.adminAccountIds.includes(linked.id)) group.adminAccountIds.push(linked.id);
            }
          }
        }
        if (event.action === 'demote') {
          group.adminIds = (group.adminIds || []).filter(
            (adminId) => !changed.some((identity) => identityMatches(adminId, identity))
          );
          for (const identity of changed) {
            const member = group.members.find((item) => identityMatches(item, identity));
            if (member) member.isAdmin = false;
            const linked = this.db.data.accounts.find((item) => identityMatches(item, identity));
            if (linked) {
              group.adminAccountIds = (group.adminAccountIds || []).filter((id) => id !== linked.id);
            }
          }
        }
        group.memberCount = group.members.length;
        group.lastSyncedAt = new Date().toISOString();
        group.hasError = group.adminIds.length === 0 && !group.members.some((member) => member.isAdmin);
        this.db.save();
        this.emit('groups:update');
        this.refreshGroup(group.id).catch(() => {});
      } catch (error) {
        console.error('group-participants.update handler failed:', error);
      }
    });
  }

  scheduleReconnect(accountId) {
    if (this.stopping) return;
    const account = this.db.findAccount(accountId);
    if (!account || account.status === 'banned' || account.needsRelink) return;
    const attempts = (this.reconnectAttempts.get(accountId) || 0) + 1;
    this.reconnectAttempts.set(accountId, attempts);
    const delay = Math.min(60000, 1500 * Math.pow(1.8, attempts)) + Math.floor(Math.random() * 1500);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(accountId);
      this.startAccount(accountId).catch((error) => {
        console.error('Reconnect failed:', error);
        this.scheduleReconnect(accountId);
      });
    }, delay);
    this.reconnectTimers.set(accountId, timer);
  }

  async stopAccount(accountId) {
    this.manualStops.add(accountId);
    const timer = this.reconnectTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(accountId);
    }
    const entry = this.sockets.get(accountId);
    if (!entry) return;
    this.sockets.delete(accountId);
    try {
      entry.sock.end(undefined);
    } catch (error) {
      console.error('Failed to close socket:', error);
    }
    const account = this.db.findAccount(accountId);
    if (account && account.status !== 'banned') {
      account.status = account.pausedForDay === this.db.todayKey() ? 'paused' : 'disconnected';
      this.db.save();
    }
  }

  async addAccount(alias) {
    if (this.db.data.accounts.length >= this.db.data.settings.maxAccounts) {
      throw new Error(`You can link up to ${this.db.data.settings.maxAccounts} admin accounts.`);
    }
    const cleanAlias = (alias || '').trim();
    if (!cleanAlias) throw new Error('Give this account an alias.');
    if (cleanAlias.length > 40) throw new Error('Alias must be 40 characters or fewer.');
    if (this.db.data.accounts.some((account) => account.alias.toLowerCase() === cleanAlias.toLowerCase())) {
      throw new Error('An account with this alias already exists.');
    }
    const account = this.db.addAccount(cleanAlias);
    this.emit('accounts:update');
    this.startAccount(account.id).catch((error) => {
      console.error('Failed to start new account:', error);
      this.emit('toast', { type: 'error', message: friendlyError(error) });
    });
    return account.id;
  }

  async relinkAccount(accountId) {
    const account = this.db.findAccount(accountId);
    if (!account) throw new Error('Account not found.');
    await this.stopAccount(accountId);
    const folder = path.join(this.sessionsRoot, account.authFolder);
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to clear old session:', error);
    }
    const previousIdentity = identitySummary(account);
    account.phoneNumber = '';
    account.whatsappId = '';
    account.whatsappJid = '';
    account.whatsappLid = '';
    for (const group of this.db.data.groups) {
      group.adminAccountIds = (group.adminAccountIds || []).filter((id) => id !== accountId);
      group.adminIds = (group.adminIds || []).filter((adminId) => !identityMatches(adminId, previousIdentity));
      group.members = (group.members || []).filter((member) => !identityMatches(member, previousIdentity));
      group.memberCount = group.members.length;
      group.hasError = group.adminIds.length === 0 && !group.members.some((member) => member.isAdmin);
    }
    account.status = 'disconnected';
    account.needsRelink = false;
    account.pendingOnboarding = true;
    account.onboardingError = null;
    account.adminAccess = {};
    account.qr = null;
    account.connectedAt = null;
    account.lastError = null;
    this.db.save();
    this.emit('accounts:update');
    await this.startAccount(accountId);
    return true;
  }

  async removeAccount(accountId) {
    const account = this.db.findAccount(accountId);
    if (!account) throw new Error('Account not found.');
    const entry = this.sockets.get(accountId);
    if (entry) {
      try {
        await entry.sock.logout();
      } catch (error) {
        try {
          entry.sock.end(undefined);
        } catch (err) {
          console.error(err);
        }
      }
      this.sockets.delete(accountId);
    }
    const timer = this.reconnectTimers.get(accountId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(accountId);
    const folder = path.join(this.sessionsRoot, account.authFolder);
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to delete session folder:', error);
    }
    this.db.data.accounts = this.db.data.accounts.filter((item) => item.id !== accountId);
    for (const group of this.db.data.groups) {
      group.adminAccountIds = (group.adminAccountIds || []).filter((id) => id !== accountId);
      group.adminIds = (group.adminIds || []).filter((adminId) => !identityMatches(adminId, account));
      group.members = (group.members || []).filter((member) => !identityMatches(member, account));
      group.memberCount = group.members.length;
      group.hasError = group.adminIds.length === 0 && !group.members.some((member) => member.isAdmin);
    }
    for (const contact of this.db.data.contacts) {
      contact.sourceAccounts = (contact.sourceAccounts || []).filter((id) => id !== accountId);
    }
    this.db.save();
    this.emit('accounts:update');
    this.emit('groups:update');
    return true;
  }

  enqueueContactWork(accountId, work) {
    const previous = this.contactIngestChains.get(accountId) || Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(work)
      .catch((error) => {
        console.error('Contact work failed:', error);
        return 0;
      });
    this.contactIngestChains.set(accountId, run);
    const cleanup = () => {
      if (this.contactIngestChains.get(accountId) === run) {
        this.contactIngestChains.delete(accountId);
      }
    };
    run.then(cleanup, cleanup);
    return run;
  }

  countNamedContacts() {
    const contacts = Array.isArray(this.db.data.contacts) ? this.db.data.contacts : [];
    return contacts.reduce((count, contact) => count + (sanitizeContactName(contact.name) ? 1 : 0), 0);
  }

  countNamedGroupMembers() {
    let total = 0;
    let named = 0;
    const groups = Array.isArray(this.db.data.groups) ? this.db.data.groups : [];
    for (const group of groups) {
      for (const member of group.members || []) {
        total += 1;
        if (this.db.contactName(member)) named += 1;
      }
    }
    return { total, named };
  }

  flushBufferedSocketEvents(entry) {
    const ev = entry && entry.sock && entry.sock.ev;
    if (ev && typeof ev.flush === 'function') ev.flush();
  }

  async waitForContactIngest(accountId) {
    let chain = this.contactIngestChains.get(accountId);
    while (chain) {
      await chain.catch(() => {});
      const current = this.contactIngestChains.get(accountId);
      if (!current || current === chain) break;
      chain = current;
    }
  }

  handleContactsUpsert(accountId, contacts) {
    if (!Array.isArray(contacts) || contacts.length === 0) return Promise.resolve(0);
    const entry = this.sockets.get(accountId);
    if (entry && entry.appStateResyncStatus === 'running') {
      entry.appStateResyncEvents += 1;
      if (!(entry.appStateResyncIdentities instanceof Set)) {
        entry.appStateResyncIdentities = new Set();
      }
      for (const contact of contacts) {
        entry.appStateResyncContacts += 1;
        if (contactNameDetails(contact, '').name) entry.appStateResyncNamedContacts += 1;
        const identity = participantIdentity(contact, contact);
        const keys = identityKeys(identity);
        if (keys.size > 0) {
          entry.appStateResyncIdentities.add(Array.from(keys).sort().join('\u0000'));
        }
      }
    }
    contactDiagnostics.recordContactBatch('contacts.upsert', contacts, this.db);
    return this.ingestContacts(accountId, contacts, { event: 'contacts.upsert' });
  }

  resyncAccountAppState(accountId) {
    const entry = this.sockets.get(accountId);
    if (!entry || !entry.connected || !entry.sock) {
      return Promise.resolve({ accountId, status: 'skipped', reason: 'not_connected' });
    }
    if (entry.appStateResyncStarted) {
      return entry.appStateResyncPromise || Promise.resolve({ accountId, status: 'skipped', reason: 'already_started' });
    }

    entry.appStateResyncStarted = true;
    entry.appStateResyncStatus = 'running';
    entry.appStateResyncStartedAt = new Date().toISOString();
    entry.appStateResyncCompletedAt = null;
    entry.appStateResyncError = '';
    entry.appStateResyncEvents = 0;
    entry.appStateResyncContacts = 0;
    entry.appStateResyncNamedContacts = 0;
    entry.appStateResyncIdentities = new Set();
    entry.appStateResyncForcedSnapshot = false;

    const run = this.performAppStateResync(accountId, entry).catch((error) => {
      entry.appStateResyncStatus = 'failed';
      entry.appStateResyncCompletedAt = new Date().toISOString();
      entry.appStateResyncError = error && error.message ? error.message : String(error);
      const stats = {
        accountId,
        status: 'failed',
        error: entry.appStateResyncError,
        startedAt: entry.appStateResyncStartedAt,
        completedAt: entry.appStateResyncCompletedAt,
        forcedSnapshot: Boolean(entry.appStateResyncForcedSnapshot),
        contactsUpsertEvents: entry.appStateResyncEvents,
        contactsReceived: entry.appStateResyncContacts,
        uniqueContacts: entry.appStateResyncIdentities instanceof Set ? entry.appStateResyncIdentities.size : 0
      };
      this.lastAppStateResyncStats = stats;
      console.error('[APP-STATE] Resync failed', stats);
      return stats;
    });

    entry.appStateResyncPromise = run;
    return run;
  }

  async performAppStateResync(accountId, entry) {
    const startedAt = process.hrtime.bigint();
    const contactsBefore = Array.isArray(this.db.data.contacts) ? this.db.data.contacts.length : 0;
    const namedBefore = this.countNamedContacts();
    const groupBefore = this.countNamedGroupMembers();
    console.log('[APP-STATE] Resync started', { accountId });

    if (!Array.isArray(entry.appStatePatchNames) || entry.appStatePatchNames.length === 0) {
      const error = new Error('Baileys ALL_WA_PATCH_NAMES is unavailable.');
      error.code = 'APP_STATE_PATCH_NAMES_UNAVAILABLE';
      throw error;
    }
    if (typeof entry.sock.resyncAppState !== 'function') {
      const error = new Error('Baileys socket does not expose resyncAppState().');
      error.code = 'APP_STATE_RESYNC_UNAVAILABLE';
      throw error;
    }

    const ensureActive = () => {
      if (this.sockets.get(accountId) !== entry || !entry.connected) {
        const error = new Error('Account disconnected during app-state resync.');
        error.code = 'APP_STATE_DISCONNECTED';
        throw error;
      }
    };

    await entry.sock.resyncAppState(entry.appStatePatchNames, true);
    this.flushBufferedSocketEvents(entry);
    await this.waitForContactIngest(accountId);
    ensureActive();

    const namedAfterPlain = this.countNamedContacts();
    const contactsAfterPlain = Array.isArray(this.db.data.contacts) ? this.db.data.contacts.length : 0;
    const hasUnnamedContacts = contactsAfterPlain > namedAfterPlain;
    if (
      entry.appStateResyncEvents === 0
      && hasUnnamedContacts
      && !entry.appStateResyncForcedSnapshot
      && !this.appStateForcedSnapshots.has(accountId)
    ) {
      entry.appStateResyncForcedSnapshot = true;
      console.log('[APP-STATE] Resync forcing critical_unblock_low snapshot', { accountId });
      if (!entry.authKeys || typeof entry.authKeys.set !== 'function') {
        const error = new Error('Encrypted auth keys are unavailable for app-state snapshot reset.');
        error.code = 'APP_STATE_AUTH_KEYS_UNAVAILABLE';
        throw error;
      }
      await entry.authKeys.set({
        'app-state-sync-version': { [APP_STATE_CONTACT_COLLECTION]: null }
      });
      this.appStateForcedSnapshots.add(accountId);
      await entry.sock.resyncAppState([APP_STATE_CONTACT_COLLECTION], true);
      this.flushBufferedSocketEvents(entry);
      await this.waitForContactIngest(accountId);
      ensureActive();
    }

    const contactsAfter = Array.isArray(this.db.data.contacts) ? this.db.data.contacts.length : 0;
    const namedAfter = this.countNamedContacts();
    const groupAfter = this.countNamedGroupMembers();
    const uniqueContacts = entry.appStateResyncIdentities instanceof Set
      ? entry.appStateResyncIdentities.size
      : 0;
    const contactsCreated = Math.max(0, contactsAfter - contactsBefore);
    const status = (entry.appStateResyncNamedContacts > 0 || namedAfter > namedBefore)
      ? 'completed'
      : 'completed_no_names';
    const completedAt = new Date().toISOString();
    const stats = {
      accountId,
      status,
      startedAt: entry.appStateResyncStartedAt,
      completedAt,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      patchCollections: entry.appStatePatchNames.slice(),
      forcedSnapshot: Boolean(entry.appStateResyncForcedSnapshot),
      contactsUpsertEvents: entry.appStateResyncEvents,
      contactsReceived: entry.appStateResyncContacts,
      namedContactsReceived: entry.appStateResyncNamedContacts,
      uniqueContacts,
      contactsBefore,
      contactsAfter,
      contactsCreated,
      contactsUpdated: Math.max(0, uniqueContacts - contactsCreated),
      namedContactsBefore: namedBefore,
      namedContactsAfter: namedAfter,
      namedRecovered: Math.max(0, namedAfter - namedBefore),
      namedPersisted: namedAfter,
      groupMembersBefore: groupBefore.named,
      groupMembersAfter: groupAfter.named,
      groupMembersEnriched: Math.max(0, groupAfter.named - groupBefore.named)
    };

    entry.appStateResyncStatus = status;
    entry.appStateResyncCompletedAt = completedAt;
    this.lastAppStateResyncStats = stats;
    console.log(
      status === 'completed'
        ? '[APP-STATE] Resync completed'
        : '[APP-STATE] Resync completed with no new names',
      stats
    );
    return stats;
  }

  ingestContacts(accountId, contacts, options = {}) {
    if (!Array.isArray(contacts) || contacts.length === 0) return Promise.resolve(0);
    return this.enqueueContactWork(accountId, () => this.processContactIngest(accountId, contacts, options));
  }

  ingestChats(accountId, chats, event = 'chats.upsert') {
    if (!Array.isArray(chats) || chats.length === 0) return Promise.resolve(0);
    const contacts = [];
    const seen = new Set();
    for (const chat of chats) {
      if (!chat || !chat.id) continue;
      const name = sanitizeContactName(chat.name) || sanitizeContactName(chat.displayName);
      const notify = sanitizeContactName(chat.notify);
      if (!name && !notify) continue;
      const identity = participantIdentity({
        id: chat.id,
        jid: chat.pnJid || (isPnJid(chat.id) ? chat.id : ''),
        lid: chat.lidJid || (isLidJid(chat.id) ? chat.id : '')
      }, {});
      if (!isPnJid(identity.jid) && !isLidJid(identity.lid)) continue;
      const keys = identityKeys(identity);
      if (!keys.size) continue;
      const dedupeKey = Array.from(keys).sort().join('\u0000');
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      contacts.push({
        id: identity.id,
        jid: identity.jid,
        lid: identity.lid,
        phoneNumber: identity.phoneNumber,
        name,
        notify
      });
    }
    if (contacts.length === 0) return Promise.resolve(0);
    return this.ingestContacts(accountId, contacts, { sourceType: 'chat', event });
  }

  ingestHistory(accountId, data) {
    if (!data || typeof data !== 'object') return Promise.resolve(0);
    const work = [];
    if (Array.isArray(data.contacts) && data.contacts.length > 0) {
      work.push(this.ingestContacts(accountId, data.contacts, {
        sourceType: 'contact',
        event: 'messaging-history.set.contacts'
      }));
    }
    if (Array.isArray(data.chats) && data.chats.length > 0) {
      work.push(this.ingestChats(accountId, data.chats, 'messaging-history.set.chats'));
    }
    if (work.length === 0) return Promise.resolve(0);
    return Promise.all(work).then((counts) => counts.reduce((total, count) => total + (Number(count) || 0), 0));
  }

  linkContactIdentities(accountId, share) {
    if (!share || (!share.lid && !share.jid)) return Promise.resolve(0);
    return this.enqueueContactWork(accountId, () => {
      const result = this.db.linkContactIdentities(share, accountId);
      if (!result || !result.contact) return 0;
      const changed = this.db.refreshCachedDisplayNames([result.contact]);
      if (result.changed || changed > 0) {
        this.db.save();
        this.emit('contacts:update');
        if (changed > 0) this.emit('groups:update');
      }
      return 1;
    });
  }

  async processContactIngest(accountId, contacts, options = {}) {
    const startedAt = process.hrtime.bigint();
    const eventLoopStart = performance.eventLoopUtilization();
    const contactsBefore = Array.isArray(this.db.data.contacts) ? this.db.data.contacts.length : 0;
    const readIndexStats = () => (typeof this.db.getContactIndexStats === 'function'
      ? this.db.getContactIndexStats()
      : null);
    const indexBefore = readIndexStats();
    const sourceType = options.sourceType || 'contact';
    const stats = {
      accountId,
      sourceType,
      received: contacts.length,
      uniqueParticipants: 0,
      created: 0,
      updated: 0,
      batches: 0,
      yields: 0,
      durationMs: 0,
      indexHits: 0,
      indexMisses: 0
    };
    const pending = [];
    const seen = new Set();

    for (const contact of contacts) {
      const identity = participantIdentity(contact, contact);
      if (!identity.id) continue;
      const keys = identityKeys(identity);
      if (!keys.size) continue;
      const dedupeKey = Array.from(keys).sort().join('\u0000');
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const details = contactNameDetails(contact, 'whatsapp');
      pending.push({ identity, name: details.name, nameSource: details.nameSource });
    }

    stats.uniqueParticipants = pending.length;
    const batchSize = Math.max(1, Number(this.contactSyncBatchSize) || CONTACT_SYNC_BATCH_SIZE);
    stats.batches = Math.ceil(pending.length / batchSize);
    const touchedContacts = [];
    const diagnosticsEnabled = contactDiagnostics.isEnabled();
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      const existingCount = Array.isArray(this.db.data.contacts) ? this.db.data.contacts.length : 0;
      let diagnosticBefore = null;
      if (diagnosticsEnabled) {
        const existing = this.db.findContact(item.identity);
        diagnosticBefore = {
          name: existing ? existing.name : '',
          nameSource: existing ? existing.nameSource : '',
          displayName: existing ? this.db.contactName(item.identity) : ''
        };
      }
      const contact = this.db.upsertContactIdentity(item.identity, item.name, accountId, sourceType, item.nameSource);
      if (contact) touchedContacts.push(contact);
      if (diagnosticsEnabled) {
        const cleanIncoming = sanitizeContactName(item.name);
        const afterName = contact ? sanitizeContactName(contact.name) : '';
        const afterDisplay = contact ? this.db.contactName(item.identity) : '';
        contactDiagnostics.recordWrite({
          event: options.event || sourceType,
          accountId,
          identity: item.identity,
          incomingName: cleanIncoming,
          incomingNameSource: item.nameSource,
          beforeName: diagnosticBefore.name,
          beforeNameSource: diagnosticBefore.nameSource,
          beforeDisplayName: diagnosticBefore.displayName,
          afterName,
          afterNameSource: contact ? contact.nameSource : '',
          afterDisplayName: afterDisplay,
          persisted: Boolean(cleanIncoming && contact && (afterName === cleanIncoming || afterDisplay === cleanIncoming))
        });
      }
      const nextCount = Array.isArray(this.db.data.contacts) ? this.db.data.contacts.length : 0;
      if (nextCount > existingCount) {
        stats.created += 1;
      } else {
        stats.updated += 1;
      }
      if ((index + 1) % batchSize === 0 && index + 1 < pending.length) {
        stats.yields += 1;
        await yieldToEventLoop();
      }
    }

    if (pending.length > 0) {
      const namesChanged = this.db.refreshCachedDisplayNames(touchedContacts);
      this.db.save();
      this.emit('contacts:update');
      if (namesChanged > 0) this.emit('groups:update');
    }

    stats.durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const indexAfter = readIndexStats();
    if (indexAfter) {
      stats.indexHits = indexAfter.hits - (indexBefore ? indexBefore.hits : 0);
      stats.indexMisses = indexAfter.misses - (indexBefore ? indexBefore.misses : 0);
    }
    stats.contactsAdded = (Array.isArray(this.db.data.contacts) ? this.db.data.contacts.length : 0) - contactsBefore;
    const eventLoopEnd = performance.eventLoopUtilization();
    const eventLoopDelta = performance.eventLoopUtilization(eventLoopEnd, eventLoopStart);
    stats.eventLoopUtilization = eventLoopDelta.utilization;
    stats.eventLoopActiveMs = eventLoopDelta.active;
    stats.eventLoopIdleMs = eventLoopDelta.idle;
    this.lastContactIngestStats = stats;
    logger.info({ event: 'contacts:ingest', ...stats }, 'contact ingest completed');
    return stats.uniqueParticipants;
  }

  async syncContacts(accountId) {
    const entry = this.sockets.get(accountId);
    if (!entry || !entry.connected) return 0;

    const startedAt = process.hrtime.bigint();
    const eventLoopStart = performance.eventLoopUtilization();
    const contactsBefore = this.db.data.contacts.length;
    const readIndexStats = () => (typeof this.db.getContactIndexStats === 'function'
      ? this.db.getContactIndexStats()
      : null);
    const indexBefore = readIndexStats();
    const stats = {
      accountId,
      groupCount: 0,
      participantOccurrences: 0,
      uniqueParticipants: 0,
      created: 0,
      updated: 0,
      batches: 0,
      yields: 0,
      durationMs: 0,
      indexHits: 0,
      indexMisses: 0
    };

    try {
      const groups = await entry.sock.groupFetchAllParticipating();
      const groupList = Object.values(groups || {});
      stats.groupCount = groupList.length;

      const pending = [];
      const seen = new Set();
      for (const metadata of groupList) {
        logRawGroupParticipants('groupFetchAllParticipating', metadata);
        for (const participant of metadata.participants || []) {
          stats.participantOccurrences += 1;
          const identity = participantIdentity(participant, participant);
          if (!identity.id) continue;
          const keys = identityKeys(identity);
          if (!keys.size) continue;
          const dedupeKey = Array.from(keys).sort().join('\u0000');
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          const details = contactNameDetails(participant, 'participant');
          pending.push({ identity, name: details.name, nameSource: details.nameSource });
        }
      }

      stats.uniqueParticipants = pending.length;
      const batchSize = Math.max(1, Number(this.contactSyncBatchSize) || CONTACT_SYNC_BATCH_SIZE);
      stats.batches = Math.ceil(pending.length / batchSize);
      const touchedContacts = [];
      for (let index = 0; index < pending.length; index += 1) {
        const item = pending[index];
        const existingCount = this.db.data.contacts.length;
        const contact = this.db.upsertContactIdentity(item.identity, item.name, accountId, 'group', item.nameSource);
        if (contact) touchedContacts.push(contact);
        if (this.db.data.contacts.length > existingCount) {
          stats.created += 1;
        } else {
          stats.updated += 1;
        }
        if ((index + 1) % batchSize === 0 && index + 1 < pending.length) {
          stats.yields += 1;
          await yieldToEventLoop();
        }
      }

      const namesChanged = this.db.refreshCachedDisplayNames(touchedContacts);
      this.db.save();
      this.emit('contacts:update');
      if (namesChanged > 0) this.emit('groups:update');
    } catch (error) {
      console.error('Contact sync failed:', error);
      throw error;
    } finally {
      stats.durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const indexAfter = readIndexStats();
      if (indexAfter) {
        stats.indexHits = indexAfter.hits - (indexBefore ? indexBefore.hits : 0);
        stats.indexMisses = indexAfter.misses - (indexBefore ? indexBefore.misses : 0);
      }
      stats.contactsAdded = this.db.data.contacts.length - contactsBefore;
      const eventLoopEnd = performance.eventLoopUtilization();
      const eventLoopDelta = performance.eventLoopUtilization(eventLoopEnd, eventLoopStart);
      stats.eventLoopUtilization = eventLoopDelta.utilization;
      stats.eventLoopActiveMs = eventLoopDelta.active;
      stats.eventLoopIdleMs = eventLoopDelta.idle;
      this.lastContactSyncStats = stats;
      logger.info({ event: 'contacts:sync', ...stats }, 'contact sync completed');
    }

    return stats.uniqueParticipants;
  }

  async refreshAllContacts() {
    let total = 0;
    const failed = [];
    for (const account of this.db.data.accounts) {
      if (account.status !== 'connected' && account.status !== 'paused') continue;
      try {
        total += await this.syncContacts(account.id);
      } catch (error) {
        console.error(`Contact refresh failed for ${account.alias}:`, error);
        failed.push({ id: account.id, alias: account.alias, error: friendlyError(error) });
      }
    }
    this.emit('contacts:update');
    return { total, failed };
  }

  async fetchGroups(accountId) {
    const entry = this.sockets.get(accountId);
    const account = this.db.findAccount(accountId);
    if (!entry || !entry.connected) throw new Error('This account is not connected.');
    const groups = await entry.sock.groupFetchAllParticipating();
    const result = [];
    for (const metadata of Object.values(groups || {})) {
      logRawGroupParticipants('groupFetchAllParticipating', metadata);
      const participants = metadata.participants || [];
      const matchingParticipants = participants.filter((participant) => identityMatches(participant, account));
      const me = matchingParticipants.find((participant) => participantIsAdmin(participant)) || matchingParticipants[0];
      if (!me && account) {
        console.info('[identity] connected account was not found in group participants', {
          groupId: metadata.id,
          addressingMode: metadata.addressingMode,
          account: identitySummary(account)
        });
      }
      for (const participant of participants) {
        const identity = participantIdentity(participant, participant);
        const nameSource = sanitizeContactName(participant.name)
          ? 'participant'
          : sanitizeContactName(participant.notify)
            ? 'notify'
            : sanitizeContactName(participant.verifiedName)
              ? 'verified'
              : '';
        const name = sanitizeContactName(participant.name) || sanitizeContactName(participant.notify) || sanitizeContactName(participant.verifiedName);
        if (identity.id) this.db.upsertContactIdentity(identity, name, accountId, 'group', nameSource || 'participant');
      }
      result.push({
        id: metadata.id,
        name: metadata.subject || 'Unnamed group',
        memberCount: participants.length,
        isAdmin: participantIsAdmin(me),
        alreadyManaged: this.db.data.groups.some((group) => group.id === metadata.id)
      });
    }
    this.db.save();
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }

  applyMetadataToGroup(group, metadata, account, markAdmin) {
    const participants = metadata.participants || [];
    const previousMembers = new Map();
    for (const member of group.members || []) {
      for (const key of identityKeys(member)) {
        if (!previousMembers.has(key)) previousMembers.set(key, member);
      }
    }

    const members = participants.map((participant) => {
      const identity = participantIdentity(participant, participant);
      let previous = null;
      for (const key of identityKeys(identity)) {
        if (previousMembers.has(key)) {
          previous = previousMembers.get(key);
          break;
        }
      }
      const contactName = this.db.contactName(identity);
      const participantName = sanitizeContactName(participant.name) || sanitizeContactName(participant.notify) || sanitizeContactName(participant.verifiedName);
      const name = contactName || participantName || '';
      if (identity.id && participantName && !contactName) {
        const nameSource = sanitizeContactName(participant.name)
          ? 'participant'
          : sanitizeContactName(participant.notify)
            ? 'notify'
            : 'verified';
        this.db.upsertContactIdentity(identity, participantName, account ? account.id : null, 'group', nameSource);
      }
      return {
        ...identity,
        displayName: getContactDisplayName({ localName: contactName, name: participantName }, '') || (previous && previous.displayName) || '',
        isAdmin: participantIsAdmin(participant),
        isSuperAdmin: participantIsSuperAdmin(participant),
        joinedViaApp: previous ? previous.joinedViaApp : true,
        addedAt: previous ? previous.addedAt : new Date().toISOString()
      };
    });

    const adminIdentities = participants
      .filter((participant) => participantIsAdmin(participant))
      .map((participant) => participantIdentity(participant, participant))
      .filter((identity) => identity.id);
    const adminIds = [];
    const seenAdmins = new Set();
    for (const identity of adminIdentities) {
      if (!seenAdmins.has(identity.id)) {
        seenAdmins.add(identity.id);
        adminIds.push(identity.id);
      }
    }

    group.name = metadata.subject || group.name;
    if (metadata.desc !== undefined) group.description = metadata.desc || '';
    group.addressingMode = metadata.addressingMode || group.addressingMode;
    group.memberCount = members.length;
    group.members = members;
    group.adminIds = adminIds;
    group.lastSyncedAt = new Date().toISOString();
    group.adminAccountIds = (group.adminAccountIds || []).filter((id) => {
      const linked = this.db.findAccount(id);
      return Boolean(
        linked &&
        adminIdentities.some((identity) => identityMatches(linked, identity))
      );
    });
    if (
      markAdmin &&
      account &&
      adminIdentities.some((identity) => identityMatches(account, identity)) &&
      !(group.adminAccountIds || []).includes(account.id)
    ) {
      if (!Array.isArray(group.adminAccountIds)) group.adminAccountIds = [];
      group.adminAccountIds.push(account.id);
    }
    group.hasError = adminIds.length === 0;
  }

  async addGroups(accountId, groupIds) {
    const entry = this.sockets.get(accountId);
    const account = this.db.findAccount(accountId);
    if (!entry || !entry.connected) throw new Error('This account is not connected.');
    if (!Array.isArray(groupIds) || groupIds.length === 0) throw new Error('Select at least one group.');
    const added = [];
    for (const groupId of groupIds) {
      const group = this.db.findGroup(groupId);
      if (group) {
        added.push(group);
        continue;
      }
      let metadata;
      try {
        metadata = await entry.sock.groupMetadata(groupId);
      } catch (error) {
        console.error(`Failed fetching metadata for ${groupId}:`, error);
        throw new Error(`Could not load group details: ${friendlyError(error)}`);
      }
      logRawGroupParticipants('groupMetadata', metadata);
      const newGroup = {
        id: metadata.id,
        name: metadata.subject || 'Unnamed group',
        description: metadata.desc || '',
        memberCount: (metadata.participants || []).length,
        lastSyncedAt: new Date().toISOString(),
        adminIds: [],
        adminAccountIds: [],
        members: [],
        hasOngoingAction: false,
        hasError: false,
        addedAt: new Date().toISOString(),
        addedByAccountId: accountId
      };
      this.applyMetadataToGroup(newGroup, metadata, account, true);
      newGroup.addedByAccountId = accountId;
      this.db.data.groups.push(newGroup);
      added.push(newGroup);
    }
    this.db.save();
    this.emit('groups:update');
    return added.length;
  }

  async refreshGroup(groupId, options = {}) {
    const group = this.db.findGroup(groupId);
    if (!group) throw new Error('Group not found.');
    const candidates = this.db.data.accounts.filter((account) => {
      const entry = this.sockets.get(account.id);
      if (!entry || !entry.connected) return false;
      if (this.isAdminOf(account, group)) return true;
      return (group.members || []).some((member) => identityMatches(member, account));
    });
    candidates.sort((a, b) => {
      const aAdmin = this.isAdminOf(a, group) ? 1 : 0;
      const bAdmin = this.isAdminOf(b, group) ? 1 : 0;
      return bAdmin - aAdmin;
    });
    if (candidates.length === 0) {
      const error = new Error('No connected admin account can refresh this group.');
      if (options.strict) throw error;
      group.hasError = true;
      this.db.save();
      return group;
    }
    let lastError = null;
    for (const account of candidates) {
      const entry = this.sockets.get(account.id);
      try {
        const metadata = await entry.sock.groupMetadata(groupId);
        logRawGroupParticipants('groupMetadata', metadata);
        this.applyMetadataToGroup(group, metadata, account, true);
        this.recordAdminAccess(account, group, metadata);
        this.db.save();
        this.emit('accounts:update');
        this.emit('groups:update');
        return group;
      } catch (error) {
        lastError = error;
      }
    }
    const error = new Error(`Could not refresh group: ${friendlyError(lastError)}`);
    if (options.strict) throw error;
    return group;
  }

  async refreshManagedGroups(accountId) {
    const account = this.db.findAccount(accountId);
    if (!account) return;
    const groups = this.db.data.groups.filter(
      (group) => (group.adminAccountIds || []).includes(accountId) || this.isAdminOf(account, group)
    );
    for (const group of groups) {
      try {
        await this.refreshGroup(group.id);
      } catch (error) {
        console.error(`Failed refreshing ${group.name}:`, error);
      }
    }
    this.emit('groups:update');
  }

  async sendAction(accountId, groupJid, targets, action) {
    const entry = this.sockets.get(accountId);
    const account = this.db.findAccount(accountId);
    if (!entry || !entry.connected) throw new Error('Account is disconnected.');
    if (!account) throw new Error('Account not found.');
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new Error('No WhatsApp recipients were provided.');
    }

    const jids = targets.map((target) => {
      const raw = typeof target === 'string'
        ? target
        : (target && (target.jid || target.id || target.number));
      const text = raw === null || raw === undefined ? '' : String(raw).trim();
      if (!text) return null;
      if (text.includes('@')) {
        const jid = normalizeJid(text);
        return isPnJid(jid) || isLidJid(jid) ? jid : null;
      }
      const parsed = parsePhoneNumber(text);
      return parsed.valid ? jidFromPhone(parsed.canonical) : null;
    });
    if (jids.some((jid) => !jid)) {
      throw new Error('Invalid WhatsApp recipient identity. Use a phone number or a WhatsApp JID.');
    }

    const access = await this.verifyAdminAccess(accountId, groupJid);
    if (access.status !== 'verified') {
      throw actionError('admin_unverified', 'This account is not a verified admin of this group.');
    }

    if (action === 'remove') {
      const protectedAccount = this.db.data.accounts.find((linked) =>
        jids.some((jid) => identityMatches(jid, linked))
      );
      if (protectedAccount) {
        throw actionError(
          'protected_admin_target',
          `${protectedAccount.alias} is a linked admin account and cannot be removed from a group.`
        );
      }
    }

    const results = await entry.sock.groupParticipantsUpdate(groupJid, jids, action);
    if (!Array.isArray(results)) {
      return targets.map((target, index) => ({
        number: targetLabel(target),
        jid: jids[index],
        status: 200
      }));
    }
    return results.map((result, index) => {
      const numericStatus = Number(result.status);
      return {
        number: phoneFromJid(result.jid) || targetLabel(targets[index]),
        jid: normalizeJid(result.jid) || jids[index],
        status: Number.isFinite(numericStatus) ? numericStatus : result.status,
        content: result.content
      };
    });
  }

  async findGroupAdminSocket(group, excludeAccountId) {
    const candidates = this.db.data.accounts.filter((account) => {
      if (account.id === excludeAccountId) return false;
      const entry = this.sockets.get(account.id);
      return Boolean(entry && entry.connected);
    });
    for (const account of candidates) {
      const entry = this.sockets.get(account.id);
      try {
        const metadata = await entry.sock.groupMetadata(group.id);
        logRawGroupParticipants('groupMetadata', metadata);
        const me = (metadata.participants || []).find(
          (participant) => identityMatches(participant, account)
        );
        if (participantIsAdmin(me)) return { account, sock: entry.sock, metadata };
      } catch (error) {
        continue;
      }
    }
    return null;
  }

  async onboardAccount(accountId) {
    const account = this.db.findAccount(accountId);
    if (!account || !account.pendingOnboarding) return;
    if (this.onboarding.has(accountId)) return;
    const entry = this.sockets.get(accountId);
    if (!entry || !entry.connected) return;
    this.onboarding.add(accountId);
    const errors = [];
    try {
      const groups = [...this.db.data.groups];
      for (const group of groups) {
        try {
          const access = await this.verifyAdminAccess(accountId, group.id);
          if (access.status === 'verified') {
            if (!Array.isArray(group.adminAccountIds)) group.adminAccountIds = [];
            if (!group.adminAccountIds.includes(accountId)) group.adminAccountIds.push(accountId);
            continue;
          }
          const admin = await this.findGroupAdminSocket(group, accountId);
          if (!admin) throw new Error('No connected admin account is available to promote this account.');
          const isMember = (admin.metadata.participants || []).some(
            (participant) => identityMatches(participant, account)
          );
          if (!isMember) {
            const code = await admin.sock.groupInviteCode(group.id);
            await entry.sock.groupAcceptInvite(code);
            await sleep(2500);
          }
          const targetJid = preferredAccountJid(account, {
            ...group,
            addressingMode: admin.metadata.addressingMode || group.addressingMode
          });
          if (!targetJid) throw new Error('This account has no usable WhatsApp identity for promotion.');
          let promoted = false;
          for (let attempt = 0; attempt < 3 && !promoted; attempt += 1) {
            try {
              await admin.sock.groupParticipantsUpdate(group.id, [targetJid], 'promote');
              promoted = true;
            } catch (error) {
              await sleep(2000);
            }
          }
          if (!promoted) throw new Error('WhatsApp did not allow the promotion step.');
          if (!Array.isArray(group.adminAccountIds)) group.adminAccountIds = [];
          if (!group.adminAccountIds.includes(accountId)) group.adminAccountIds.push(accountId);
          if (!group.adminIds.some((adminId) => identityMatches(adminId, targetJid))) {
            group.adminIds.push(targetJid);
          }
          const promotedMember = group.members.find((member) => identityMatches(member, targetJid));
          if (promotedMember) promotedMember.isAdmin = true;
          group.hasError = group.adminIds.length === 0;
          await this.refreshGroup(group.id).catch(() => {});
          this.db.save();
          this.emit('groups:update');
          this.emit('toast', {
            type: 'success',
            message: `${account.alias} is now an admin of ${group.name}.`
          });
        } catch (error) {
          errors.push(`${group.name}: ${friendlyError(error)}`);
          this.db.addLog({
            jobId: null,
            numberOrAction: `onboard:${group.name}`,
            accountUsed: account.alias,
            result: 'failure',
            errorMessage: friendlyError(error)
          });
        }
      }
      account.pendingOnboarding = false;
      account.onboardingError = errors.length ? errors.join('\n') : null;
      this.db.save();
      this.emit('accounts:update');
      if (errors.length) {
        this.emit('toast', {
          type: 'error',
          message: `${account.alias} joined some groups, but ${errors.length} group(s) need attention.`
        });
      }
    } finally {
      this.onboarding.delete(accountId);
    }
  }

  async groupInviteCodeFor(groupId) {
    const group = this.db.findGroup(groupId);
    if (!group) throw new Error('Group not found.');
    for (const account of this.db.data.accounts) {
      const entry = this.sockets.get(account.id);
      if (!entry || !entry.connected) continue;
      const access = await this.verifyAdminAccess(account.id, groupId);
      if (access.status !== 'verified') continue;
      try {
        return await entry.sock.groupInviteCode(groupId);
      } catch (error) {
        continue;
      }
    }
    throw new Error('No connected admin account could create an invite link.');
  }
}

module.exports = {
  SessionManager,
  normalizePhone,
  phoneFromJid,
  friendlyError,
  shouldProcessHistorySync
};
