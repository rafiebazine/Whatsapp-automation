const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const pino = require('pino');
const QRCode = require('qrcode');
const { loadBaileys } = require('./baileys-loader');
const { useEncryptedAuthState } = require('./auth-store');

const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function phoneFromJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  if (!jid.includes('@s.whatsapp.net')) return '';
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

function normalizePhone(value) {
  if (value === null || value === undefined) return '';
  let text = String(value).trim();
  if (!text) return '';
  text = text.replace(/[\s\-().]/g, '');
  if (text.startsWith('00')) text = `+${text.slice(2)}`;
  const hasPlus = text.startsWith('+');
  const digits = text.replace(/\D/g, '');
  if (!digits) return '';
  if (!hasPlus && digits.length < 8) return '';
  if (digits.length < 8 || digits.length > 15) return '';
  return `+${digits}`;
}

function friendlyError(error) {
  const text = (error && (error.message || error.toString())) || 'Unknown error';
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

  isAdminOf(account, group) {
    if (!account || !group) return false;
    return Boolean(
      (account.phoneNumber && group.adminIds && group.adminIds.includes(account.phoneNumber)) ||
      (group.adminAccountIds && group.adminAccountIds.includes(account.id))
    );
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
    const { fetchLatestBaileysVersion, DisconnectReason, Browsers } = baileys;

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
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 2000,
      getMessage: async () => undefined
    });

    const entry = { sock, connected: false, saveCreds: authState.saveCreds, syncing: false };
    this.sockets.set(accountId, entry);
    this.manualStops.delete(accountId);

    sock.ev.on('creds.update', async () => {
      try {
        await authState.saveCreds();
        if (sock.user && sock.user.id) {
          const phone = phoneFromJid(sock.user.id);
          if (phone && account.phoneNumber !== phone) {
            account.phoneNumber = phone;
            this.db.save();
            this.emit('accounts:update');
          }
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
            account.phoneNumber = phoneFromJid(sock.user.id);
          }
          const autoPaused = account.pausedForDay && account.pausedForDay === this.db.todayKey();
          account.status = autoPaused ? 'paused' : 'connected';
          account.lastError = null;
          this.reconnectAttempts.set(account.id, 0);
          this.db.save();
          this.emit('accounts:update');
          this.emit('connection:open', { accountId: account.id });
          this.syncContacts(account.id).catch(() => {});
          this.refreshManagedGroups(account.id).catch(() => {});
          if (account.pendingOnboarding) {
            this.onboardAccount(account.id).catch(() => {});
          }
        }

        if (connection === 'close') {
          entry.connected = false;
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
      this.ingestContacts(account.id, contacts);
    });

    sock.ev.on('contacts.update', (contacts) => {
      this.ingestContacts(account.id, contacts);
    });

    sock.ev.on('messaging-history.set', (data) => {
      if (data && Array.isArray(data.contacts)) {
        this.ingestContacts(account.id, data.contacts);
      }
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
        const changedNumbers = (event.participants || []).map(phoneFromJid).filter(Boolean);
        if (event.action === 'add') {
          for (const number of changedNumbers) {
            if (!group.members.some((member) => member.phoneNumber === number)) {
              group.members.push({
                phoneNumber: number,
                displayName: this.db.contactName(number),
                joinedViaApp: false,
                addedAt: new Date().toISOString()
              });
            }
          }
        }
        if (event.action === 'remove') {
          group.members = group.members.filter((member) => !changedNumbers.includes(member.phoneNumber));
        }
        if (event.action === 'promote') {
          for (const number of changedNumbers) {
            if (!group.adminIds.includes(number)) group.adminIds.push(number);
            const linked = this.db.data.accounts.find((item) => item.phoneNumber === number);
            if (linked && !group.adminAccountIds.includes(linked.id)) group.adminAccountIds.push(linked.id);
          }
        }
        if (event.action === 'demote') {
          group.adminIds = group.adminIds.filter((number) => !changedNumbers.includes(number));
        }
        group.memberCount = group.members.length;
        group.lastSyncedAt = new Date().toISOString();
        group.hasError = group.adminIds.length === 0;
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
    account.phoneNumber = '';
    account.status = 'disconnected';
    account.needsRelink = false;
    account.pendingOnboarding = true;
    account.onboardingError = null;
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
      if (account.phoneNumber) {
        group.adminIds = (group.adminIds || []).filter((number) => number !== account.phoneNumber);
        group.members = (group.members || []).filter((member) => member.phoneNumber !== account.phoneNumber);
        group.memberCount = group.members.length;
      }
      group.hasError = group.adminIds.length === 0;
    }
    this.db.data.contacts = this.db.data.contacts.map((contact) => ({
      ...contact,
      sourceAccounts: (contact.sourceAccounts || []).filter((id) => id !== accountId)
    }));
    this.db.save();
    this.emit('accounts:update');
    this.emit('groups:update');
    return true;
  }

  ingestContacts(accountId, contacts) {
    if (!Array.isArray(contacts)) return;
    let changed = false;
    for (const contact of contacts) {
      const phone = phoneFromJid(contact.id);
      if (!phone) continue;
      const name = contact.name || contact.notify || contact.verifiedName || '';
      this.db.upsertContact(phone, name, accountId);
      changed = true;
    }
    if (changed) {
      this.db.save();
      this.emit('contacts:update');
    }
  }

  async syncContacts(accountId) {
    const entry = this.sockets.get(accountId);
    if (!entry || !entry.connected) return 0;
    let count = 0;
    try {
      const groups = await entry.sock.groupFetchAllParticipating();
      for (const metadata of Object.values(groups || {})) {
        for (const participant of metadata.participants || []) {
          const phone = phoneFromJid(participant.id);
          if (!phone) continue;
          const name = participant.name || participant.notify || '';
          if (name) {
            this.db.upsertContact(phone, name, accountId);
            count += 1;
          }
        }
      }
      this.db.save();
      this.emit('contacts:update');
    } catch (error) {
      console.error('Contact sync failed:', error);
    }
    return count;
  }

  async refreshAllContacts() {
    let total = 0;
    for (const account of this.db.data.accounts) {
      try {
        total += await this.syncContacts(account.id);
      } catch (error) {
        console.error(`Contact refresh failed for ${account.alias}:`, error);
      }
    }
    this.emit('contacts:update');
    return total;
  }

  async fetchGroups(accountId) {
    const entry = this.sockets.get(accountId);
    const account = this.db.findAccount(accountId);
    if (!entry || !entry.connected) throw new Error('This account is not connected.');
    const groups = await entry.sock.groupFetchAllParticipating();
    const result = [];
    for (const metadata of Object.values(groups || {})) {
      const me = (metadata.participants || []).find(
        (participant) => phoneFromJid(participant.id) === account.phoneNumber
      );
      for (const participant of metadata.participants || []) {
        const phone = phoneFromJid(participant.id);
        const name = participant.name || participant.notify || '';
        if (phone && name) this.db.upsertContact(phone, name, accountId);
      }
      result.push({
        id: metadata.id,
        name: metadata.subject || 'Unnamed group',
        memberCount: (metadata.participants || []).length,
        isAdmin: Boolean(me && me.admin),
        alreadyManaged: this.db.data.groups.some((group) => group.id === metadata.id)
      });
    }
    this.db.save();
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }

  applyMetadataToGroup(group, metadata, account, markAdmin) {
    const participants = metadata.participants || [];
    const previousMembers = new Map((group.members || []).map((member) => [member.phoneNumber, member]));
    const members = participants.map((participant) => {
      const phone = phoneFromJid(participant.id);
      const previous = previousMembers.get(phone);
      const name = participant.name || participant.notify || this.db.contactName(phone) || '';
      if (phone && name && name !== phone) this.db.upsertContact(phone, name, account ? account.id : null);
      return {
        phoneNumber: phone,
        displayName: name || (previous && previous.displayName) || '',
        joinedViaApp: previous ? previous.joinedViaApp : true,
        addedAt: previous ? previous.addedAt : new Date().toISOString()
      };
    }).filter((member) => member.phoneNumber);

    const adminIds = participants
      .filter((participant) => participant.admin)
      .map((participant) => phoneFromJid(participant.id))
      .filter(Boolean);

    group.name = metadata.subject || group.name;
    group.memberCount = members.length;
    group.members = members;
    group.adminIds = adminIds;
    group.lastSyncedAt = new Date().toISOString();
    group.adminAccountIds = (group.adminAccountIds || []).filter((id) => {
      const linked = this.db.findAccount(id);
      return linked && linked.phoneNumber && adminIds.includes(linked.phoneNumber);
    });
    if (markAdmin && account && account.phoneNumber && adminIds.includes(account.phoneNumber)) {
      if (!group.adminAccountIds.includes(account.id)) group.adminAccountIds.push(account.id);
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
      return (
        group.adminIds.includes(account.phoneNumber) ||
        (group.members || []).some((member) => member.phoneNumber === account.phoneNumber) ||
        group.adminAccountIds.includes(account.id)
      );
    });
    candidates.sort((a, b) => {
      const aAdmin = group.adminIds.includes(a.phoneNumber) ? 1 : 0;
      const bAdmin = group.adminIds.includes(b.phoneNumber) ? 1 : 0;
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
        this.applyMetadataToGroup(group, metadata, account, true);
        this.db.save();
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
      (group) => group.adminAccountIds.includes(accountId) || group.adminIds.includes(account.phoneNumber)
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

  async sendAction(accountId, groupJid, numbers, action) {
    const entry = this.sockets.get(accountId);
    const account = this.db.findAccount(accountId);
    if (!entry || !entry.connected) throw new Error('Account is disconnected.');
    if (!account) throw new Error('Account not found.');
    const jids = numbers.map((number) => `${String(number).replace(/\D/g, '')}@s.whatsapp.net`);
    const results = await entry.sock.groupParticipantsUpdate(groupJid, jids, action);
    if (!Array.isArray(results)) {
      return numbers.map((number) => ({ number, status: 200 }));
    }
    return results.map((result, index) => ({
      number: phoneFromJid(result.jid) || numbers[index],
      status: result.status,
      content: result.content
    }));
  }

  async findGroupAdminSocket(group, excludeAccountId) {
    const candidates = this.db.data.accounts.filter((account) => {
      if (account.id === excludeAccountId) return false;
      const entry = this.sockets.get(account.id);
      return entry && entry.connected && group.adminIds.includes(account.phoneNumber);
    });
    for (const account of candidates) {
      const entry = this.sockets.get(account.id);
      try {
        const metadata = await entry.sock.groupMetadata(group.id);
        const me = (metadata.participants || []).find(
          (participant) => phoneFromJid(participant.id) === account.phoneNumber
        );
        if (me && me.admin) return { account, sock: entry.sock, metadata };
      } catch (error) {
        continue;
      }
    }
    return null;
  }

  async onboardAccount(accountId) {
    const account = this.db.findAccount(accountId);
    if (!account || !account.pendingOnboarding || !account.phoneNumber) return;
    if (this.onboarding.has(accountId)) return;
    const entry = this.sockets.get(accountId);
    if (!entry || !entry.connected) return;
    this.onboarding.add(accountId);
    const errors = [];
    try {
      const groups = [...this.db.data.groups];
      for (const group of groups) {
        try {
          if (group.adminIds.includes(account.phoneNumber)) {
            if (!group.adminAccountIds.includes(accountId)) group.adminAccountIds.push(accountId);
            continue;
          }
          const admin = await this.findGroupAdminSocket(group, accountId);
          if (!admin) throw new Error('No connected admin account is available to promote this account.');
          const isMember = (admin.metadata.participants || []).some(
            (participant) => phoneFromJid(participant.id) === account.phoneNumber
          );
          if (!isMember) {
            const code = await admin.sock.groupInviteCode(group.id);
            await entry.sock.groupAcceptInvite(code);
            await sleep(2500);
          }
          let promoted = false;
          for (let attempt = 0; attempt < 3 && !promoted; attempt += 1) {
            try {
              await admin.sock.groupParticipantsUpdate(
                group.id,
                [`${account.phoneNumber}@s.whatsapp.net`],
                'promote'
              );
              promoted = true;
            } catch (error) {
              await sleep(2000);
            }
          }
          if (!promoted) throw new Error('WhatsApp did not allow the promotion step.');
          if (!group.adminAccountIds.includes(accountId)) group.adminAccountIds.push(accountId);
          if (!group.adminIds.includes(account.phoneNumber)) group.adminIds.push(account.phoneNumber);
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
      if (!group.adminIds.includes(account.phoneNumber) && !group.adminAccountIds.includes(account.id)) continue;
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
  friendlyError
};
