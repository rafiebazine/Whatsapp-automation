const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { Database } = require('./db');
const { AuthVault } = require('./vault');
const { ensurePrivateDir } = require('./secure-fs');
const {
  deriveLegacyKey,
  encryptLegacyDatabase
} = require('./legacy-migration');
const { SessionManager, friendlyError } = require('./session-manager');
const {
  formatPhone,
  getContactDisplayName,
  hasActiveJobsForGroup
} = require('./identity');
const { QueueManager } = require('./queue');
const { parseSpreadsheet } = require('./spreadsheet');
const { importContacts } = require('./contact-import');
const { runWithTimeout } = require('./lifecycle');
const contactDiagnostics = require('./contact-diagnostics');

const STARTUP_STARTED_AT = Date.now();

function startupLog(message, details) {
  const elapsed = Date.now() - STARTUP_STARTED_AT;
  if (details === undefined) {
    console.log(`[STARTUP +${elapsed}ms] ${message}`);
  } else {
    console.log(`[STARTUP +${elapsed}ms] ${message}`, details);
  }
}

function startupError(message, error) {
  const elapsed = Date.now() - STARTUP_STARTED_AT;
  const detail = error && error.stack ? error.stack : error;
  if (detail === undefined) {
    console.error(`[STARTUP +${elapsed}ms] ${message}`);
  } else {
    console.error(`[STARTUP +${elapsed}ms] ${message}`, detail);
  }
}

process.on('uncaughtException', (error) => {
  startupError('Uncaught exception', error);
});

process.on('unhandledRejection', (reason) => {
  startupError('Unhandled promise rejection', reason);
});

app.setName('WhatsApp Group Manager');

let mainWindow = null;
let db = null;
let vault = null;
let sessions = null;
let queue = null;
let currentUser = null;
let mustChangePassword = false;
let databaseState = 'missing';
let lastActivityAt = Date.now();
let lastAuthAt = 0;
let autoLockWarned = false;
let autoLockTimer = null;
let quitting = false;

const DATA_DIR = process.env.WGM_DATA_DIR
  ? path.resolve(process.env.WGM_DATA_DIR)
  : app.getPath('userData');
const DB_FILE = path.join(DATA_DIR, 'whatsapp-group-manager.json');
const VAULT_FILE = path.join(DATA_DIR, 'auth-vault.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const TRUSTED_PATH = path.join(__dirname, '..', 'src', 'index.html');
const TRUSTED_URL = pathToFileURL(TRUSTED_PATH).href;
const PUBLIC_CHANNELS = new Set([
  'auth:status',
  'auth:setup',
  'auth:login',
  'auth:loginRecovery',
  'auth:resetWithRecovery'
]);
const IPC_RATE = new Map();

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send(channel, payload);
      } catch (error) {
        console.error(`Failed broadcasting ${channel}:`, error);
      }
    }
  }
}

async function finishUnlock(dek, options = {}) {
  if (db.inspect().kind === 'encrypted') {
    db.unlock(dek);
  } else {
    await encryptLegacyDatabase({
      db,
      filePath: DB_FILE,
      dek,
      oldKey: options.oldKey || null,
      sessionsRoot: SESSIONS_DIR
    });
  }
  const masterKey = Buffer.from(db.data.security.sessionMasterKey || '', 'base64');
  if (masterKey.length !== 32) throw new Error('The encrypted database session key is invalid.');
  databaseState = 'encrypted';
  sessions.setMasterKey(masterKey);
  currentUser = vault.getUsername();
  mustChangePassword = Boolean(options.mustChangePassword);
  lastActivityAt = Date.now();
  lastAuthAt = Date.now();
  autoLockWarned = false;
  startupLog('Login accepted; starting sessions in background');
  sessions.startAll().catch((error) => {
    startupError('Failed to start sessions after login', error);
  });
  queue.start();
  broadcast('auth:changed', { authenticated: true });
  return { username: currentUser, mustChangePassword };
}

function startAutoLockTimer() {
  if (autoLockTimer) clearInterval(autoLockTimer);
  autoLockTimer = setInterval(() => {
    if (!currentUser || !db || db.mode !== 'encrypted') return;
    const minutes = Number(db.data.settings.autoLockMinutes) || 0;
    if (minutes <= 0) return;
    const idleMs = Date.now() - lastActivityAt;
    const timeoutMs = minutes * 60 * 1000;
    if (idleMs < timeoutMs - 120000) return;
    if (idleMs < timeoutMs) {
      if (!autoLockWarned) {
        autoLockWarned = true;
        broadcast('auth:idleWarning', { minutes });
      }
      return;
    }
    lockApp().catch((error) => startupError('Auto-lock failed', error));
  }, 15000);
}

async function lockApp() {
  if (queue) await queue.pauseAndWait(5000);
  if (sessions) {
    await sessions.stopAll();
    sessions.setMasterKey(null);
  }
  if (db) db.lock();
  if (vault) vault.lock();
  currentUser = null;
  mustChangePassword = false;
  lastActivityAt = Date.now();
  lastAuthAt = 0;
  autoLockWarned = false;
  broadcast('auth:changed', { authenticated: false });
}

function requireAuth() {
  if (!currentUser || db.mode !== 'encrypted') throw new Error('Please log in first.');
}

function requireRecentAuth() {
  requireAuth();
  if (!lastAuthAt || Date.now() - lastAuthAt > 10 * 60 * 1000) {
    throw ipcError('reauth_required', 'Confirm your password to continue.');
  }
}

function requiredId(value, label, max = 160) {
  if (typeof value !== 'string') throw new Error(`${label} is invalid.`);
  const clean = value.trim();
  if (!clean || clean.length > max || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error(`${label} is invalid.`);
  }
  return clean;
}

function requireArray(value, label, max) {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  if (value.length > max) throw new Error(`${label} is limited to ${max} items.`);
  return value;
}

function adminAccessSummary(account) {
  const summary = { verified: [], notAdmin: [], notMember: [], unknown: [] };
  const access = account.adminAccess && typeof account.adminAccess === 'object' ? account.adminAccess : {};
  for (const [groupId, entry] of Object.entries(access)) {
    const status = entry && entry.status;
    if (status === 'verified') summary.verified.push(groupId);
    else if (status === 'not_admin') summary.notAdmin.push(groupId);
    else if (status === 'not_member') summary.notMember.push(groupId);
    else summary.unknown.push(groupId);
  }
  return summary;
}

function publicAccount(account) {
  return {
    id: account.id,
    alias: account.alias,
    phoneNumber: account.phoneNumber,
    whatsappId: account.whatsappId || '',
    whatsappJid: account.whatsappJid || '',
    whatsappLid: account.whatsappLid || '',
    status: account.status,
    dailyActionCount: account.dailyActionCount,
    dailyActionLimit: account.dailyActionLimit,
    lastActiveAt: account.lastActiveAt,
    connectedAt: account.connectedAt,
    needsRelink: account.needsRelink,
    onboardingError: account.onboardingError,
    lastError: account.lastError,
    pausedReason: account.pausedReason,
    batchPauseUntil: account.batchPauseUntil || 0,
    adminAccess: adminAccessSummary(account),
    qr: account.qr || null
  };
}

function groupSummary(group) {
  return {
    id: group.id,
    name: group.name,
    description: group.description || '',
    memberCount: group.memberCount,
    lastSyncedAt: group.lastSyncedAt,
    hasOngoingAction: hasActiveJobsForGroup(db.data.jobs, group.id),
    hasError: group.hasError,
    adminIds: group.adminIds || [],
    adminAccountIds: group.adminAccountIds || []
  };
}

function fullGroup(group) {
  return {
    ...groupSummary(group),
    members: (group.members || [])
      .map((member) => db.enrichMember(member))
      .sort((a, b) => {
        const aName = (a.displayName || a.phoneNumber || a.id || '').toLowerCase();
        const bName = (b.displayName || b.phoneNumber || b.id || '').toLowerCase();
        return aName.localeCompare(bName);
      })
  };
}

function serializeJob(job) {
  return {
    id: job.id,
    type: job.type,
    groupId: job.groupId,
    groupName: job.groupName,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    estimatedDurationSeconds: job.estimatedDurationSeconds,
    estimatedRemainingSeconds: queue ? queue.remainingSecondsFor(job) : 0,
    progress: job.progress || { processed: 0, total: (job.targets || []).length },
    total: (job.targets || []).length,
    successCount: job.successCount || 0,
    failedCount: job.failedCount || 0,
    skippedCount: job.skippedCount || 0,
    errors: job.errors || [],
    blockedReason: job.blockedReason || null,
    dismissed: Boolean(job.dismissed)
  };
}

function serializeJobs() {
  return db.data.jobs
    .filter((job) => !job.dismissed)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(serializeJob);
}

function serializeContacts() {
  return db.data.contacts
    .map((contact) => {
      const displayName = getContactDisplayName(contact);
      return {
        id: contact.id || '',
        jid: contact.jid || '',
        phoneNumber: contact.phoneNumber,
        phoneLabel: formatPhone(contact.phoneNumber),
        name: contact.name || '',
        displayName,
        localName: contact.localName || '',
        nameSource: contact.nameSource || '',
        sourceTypes: contact.sourceTypes || [],
        sourceAccounts: (contact.sourceAccounts || [])
          .map((id) => {
            const account = db.findAccount(id);
            return account ? account.alias : null;
          })
          .filter(Boolean),
        lastSyncedAt: contact.lastSyncedAt
      };
    })
    .sort((a, b) => String(a.displayName || a.phoneLabel || a.id || '')
      .localeCompare(String(b.displayName || b.phoneLabel || b.id || '')));
}

function snapshot() {
  return {
    hasUser: Boolean(vault && vault.exists()) || Boolean(db.data.auth),
    authenticated: Boolean(currentUser),
    locked: Boolean(vault && vault.exists()) && !currentUser,
    mustChangePassword,
    user: currentUser,
    accounts: db.data.accounts.map(publicAccount),
    groups: db.data.groups.map(groupSummary),
    jobs: serializeJobs(),
    settings: db.data.settings,
    contactsCount: db.data.contacts.length
  };
}

function ipcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function trustedSender(event) {
  const frame = event && event.senderFrame;
  if (!frame || frame.parent) return false;
  try {
    return fileURLToPath(frame.url) === TRUSTED_PATH;
  } catch (error) {
    return false;
  }
}

function checkIpcRate(channel) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = channel.startsWith('auth:') ? 20 : 180;
  const recent = (IPC_RATE.get(channel) || []).filter((at) => now - at < windowMs);
  if (recent.length >= limit) throw ipcError('rate_limited', 'Too many requests. Wait a moment and try again.');
  recent.push(now);
  IPC_RATE.set(channel, recent);
}

function safeIpcError(error) {
  const message = friendlyError(error);
  return message
    .replace(/(?:[A-Za-z]:\\|\/)[^\s:'"]+(?:[\\/][^\s:'"]+)+/g, '[local path]')
    .replace(/WGM-[A-Z0-9-]{8,}/gi, '[recovery key]');
}

const IPC_SCHEMAS = {
  'auth:status': [],
  'auth:setup': ['string', 'string', 'string?'],
  'auth:login': ['string', 'string'],
  'auth:loginRecovery': ['string'],
  'auth:resetWithRecovery': ['string', 'string'],
  'auth:reauth': ['string'],
  'auth:changePassword': ['string', 'string'],
  'auth:regenerateRecovery': ['string'],
  'auth:lock': [],
  'auth:logoutApp': [],
  'app:snapshot': [],
  'groups:fetchAvailable': ['string'],
  'groups:add': ['string', 'array'],
  'groups:get': ['string'],
  'groups:refresh': ['string'],
  'groups:deleteLocal': ['string'],
  'members:context': ['string', 'string'],
  'jobs:create': ['object'],
  'jobs:list': [],
  'jobs:dismiss': ['string'],
  'contacts:list': [],
  'contacts:refresh': [],
  'contacts:import': ['array'],
  'accounts:list': [],
  'accounts:add': ['string'],
  'accounts:relink': ['string'],
  'accounts:remove': ['string'],
  'settings:get': [],
  'settings:update': ['object'],
  'import:parse': ['string', 'binary'],
  'app:dataDir': []
};

function validateIpcArgs(channel, schema, args) {
  const required = schema.filter((type) => !type.endsWith('?')).length;
  if (args.length < required || args.length > schema.length) {
    throw ipcError('invalid_request', 'Invalid request arguments.');
  }
  for (let index = 0; index < args.length; index += 1) {
    const type = schema[index].replace(/\?$/, '');
    const value = args[index];
    const valid = type === 'string'
      ? typeof value === 'string'
      : type === 'array'
        ? Array.isArray(value)
        : type === 'object'
          ? Boolean(value) && typeof value === 'object' && !Array.isArray(value)
          : type === 'binary'
            ? value instanceof Uint8Array || value instanceof ArrayBuffer
            : false;
    if (!valid) throw ipcError('invalid_request', 'Invalid request arguments.');
  }
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (!trustedSender(event)) throw ipcError('untrusted_sender', 'Request blocked.');
      if (args.length > 6) throw ipcError('invalid_request', 'Too many arguments.');
      if (Buffer.byteLength(JSON.stringify(args), 'utf8') > 16 * 1024 * 1024) {
        throw ipcError('invalid_request', 'Request is too large.');
      }
      if (!PUBLIC_CHANNELS.has(channel) && (!currentUser || db.mode !== 'encrypted')) {
        throw ipcError('auth_required', 'Please log in first.');
      }
      checkIpcRate(channel);
      validateIpcArgs(channel, IPC_SCHEMAS[channel] || [], args);
      if (currentUser) {
        lastActivityAt = Date.now();
        autoLockWarned = false;
      }
      const data = await handler(...args);
      return { ok: true, data };
    } catch (error) {
      console.error(`IPC ${channel} failed:`, error);
      return { ok: false, error: safeIpcError(error), code: error && error.code ? error.code : 'error' };
    }
  });
}

function validateSettings(patch) {
  const current = { ...db.data.settings };
  const next = { ...current };
  const numbers = {
    dailyCap: [1, 200],
    minDelaySeconds: [5, 3600],
    maxDelaySeconds: [5, 3600],
    batchSize: [1, 100],
    batchPauseMinSeconds: [30, 7200],
    batchPauseMaxSeconds: [30, 7200],
    failurePauseThreshold: [1, 20],
    autoLockMinutes: [1, 240]
  };
  for (const key of Object.keys(numbers)) {
    if (patch[key] === undefined) continue;
    const value = Number(patch[key]);
    if (!Number.isFinite(value)) throw new Error(`Invalid value for ${key}.`);
    next[key] = Math.round(value);
    const [min, max] = numbers[key];
    if (next[key] < min || next[key] > max) {
      throw new Error(`Value for ${key} must be between ${min} and ${max}.`);
    }
  }
  if (next.maxDelaySeconds < next.minDelaySeconds) {
    throw new Error('Maximum delay must be greater than or equal to the minimum delay.');
  }
  if (next.batchPauseMaxSeconds < next.batchPauseMinSeconds) {
    throw new Error('Maximum batch pause must be greater than or equal to the minimum.');
  }
  const clockPattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (patch.quietStart !== undefined) {
    if (!clockPattern.test(String(patch.quietStart))) throw new Error('Quiet start must use HH:MM format.');
    next.quietStart = patch.quietStart;
  }
  if (patch.quietEnd !== undefined) {
    if (!clockPattern.test(String(patch.quietEnd))) throw new Error('Quiet end must use HH:MM format.');
    next.quietEnd = patch.quietEnd;
  }
  return next;
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showWindowLoadError(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const safeMessage = escapeHtml(message || 'The application interface could not be loaded.');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Startup error</title>
    <style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#ECE5DD;color:#1f2c33;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:24px}main{max-width:640px;background:#fff;border-radius:16px;padding:28px;box-shadow:0 12px 40px rgba(0,0,0,.12)}h1{margin:0 0 10px;font-size:20px}p{margin:0;line-height:1.5;color:#54656f}pre{margin:16px 0 0;padding:12px;border-radius:10px;background:#f5f6f6;white-space:pre-wrap;word-break:break-word;color:#b42318}</style>
    </head><body><main><h1>WhatsApp Group Manager could not start the interface</h1><p>The main process is running, but the window failed to load. Close and reopen the app. If this keeps happening, share the startup log.</p><pre>${safeMessage}</pre></main></body></html>`;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((error) => {
    startupError('Failed to load startup error page', error);
  });
  if (!mainWindow.isVisible()) mainWindow.show();
}

function createWindow() {
  startupLog('Creating browser window');
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#ECE5DD',
    show: false,
    autoHideMenuBar: true,
    title: 'WhatsApp Group Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
      spellcheck: false
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== TRUSTED_URL) {
      event.preventDefault();
      startupLog('Blocked renderer navigation', { url });
    }
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    event.preventDefault();
    startupLog('Blocked renderer redirect', { url });
  });
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  let windowShown = false;
  let showFallbackTimer = null;
  const showWindow = (reason) => {
    if (!mainWindow || mainWindow.isDestroyed() || windowShown) return;
    windowShown = true;
    if (showFallbackTimer) {
      clearTimeout(showFallbackTimer);
      showFallbackTimer = null;
    }
    mainWindow.show();
    startupLog('Window shown', { reason });
  };

  mainWindow.webContents.on('did-finish-load', () => {
    startupLog('Renderer finished loading');
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    startupError('Renderer failed to load', {
      errorCode,
      errorDescription,
      url: validatedURL
    });
    showWindowLoadError(`${errorDescription || 'Unknown load error'} (${errorCode || 'no code'})`);
    showWindow('did-fail-load');
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    startupError('Renderer process gone', details);
    showWindowLoadError(`The renderer process stopped unexpectedly (${(details && details.reason) || 'unknown reason'}).`);
    showWindow('render-process-gone');
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    startupError('Preload script failed', { preloadPath, error: error && (error.stack || error.message) });
    showWindowLoadError(`The preload script failed: ${(error && error.message) || 'unknown error'}`);
    showWindow('preload-error');
  });
  mainWindow.webContents.on('unresponsive', () => {
    startupError('Renderer became unresponsive');
    showWindow('unresponsive');
  });
  mainWindow.webContents.on('responsive', () => {
    startupLog('Renderer responsive again');
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      startupError('Renderer console error', { message, line, sourceId });
    }
  });

  mainWindow.once('ready-to-show', () => showWindow('ready-to-show'));
  showFallbackTimer = setTimeout(() => {
    startupError('Window was not shown by ready-to-show; showing fallback');
    showWindow('fallback-timeout');
  }, 5000);

  mainWindow.loadFile(TRUSTED_PATH).catch((error) => {
    startupError('loadFile failed', error);
    showWindowLoadError(error && error.message ? error.message : 'The application files could not be loaded.');
    showWindow('loadFile-catch');
  });
  mainWindow.on('closed', () => {
    if (showFallbackTimer) clearTimeout(showFallbackTimer);
    mainWindow = null;
  });
}

function wireEvents() {
  sessions.on('accounts:update', () => {
    broadcast('accounts:update', db.data.accounts.map(publicAccount));
  });
  sessions.on('groups:update', () => {
    broadcast('groups:update', db.data.groups.map(fullGroup));
  });
  sessions.on('contacts:update', () => {
    broadcast('contacts:update', { count: db.data.contacts.length });
  });
  sessions.on('qr:update', (payload) => {
    broadcast('qr:update', payload);
  });
  sessions.on('toast', (payload) => {
    broadcast('toast', payload);
  });
  sessions.on('connection:open', () => {
    if (queue) queue.kick();
  });

  queue.on('jobs:update', () => {
    broadcast('jobs:update', serializeJobs());
  });
  queue.on('groups:update', () => {
    broadcast('groups:update', db.data.groups.map(fullGroup));
  });
  queue.on('accounts:update', () => {
    broadcast('accounts:update', db.data.accounts.map(publicAccount));
  });
  queue.on('toast', (payload) => {
    broadcast('toast', payload);
  });
}

function registerIpc() {
  handle('auth:status', async () => {
    const hasVault = Boolean(vault && vault.exists());
    return {
      hasUser: hasVault || Boolean(db.data.auth),
      authenticated: Boolean(currentUser),
      locked: hasVault && !currentUser,
      needsMigration: Boolean(db.data.auth) && !hasVault,
      mustChangePassword,
      username: currentUser || (hasVault ? vault.getUsername() : (db.data.auth ? db.data.auth.username : '')),
      databaseEncrypted: databaseState === 'encrypted',
      vaultMissing: databaseState === 'encrypted' && !hasVault,
      dataDir: DATA_DIR
    };
  });

  handle('auth:setup', async (username, password, currentPassword) => {
    if (vault && vault.exists()) {
      const unlocked = vault.unlockWithPassword(username, currentPassword || password);
      return finishUnlock(unlocked.dek, { mustChangePassword: unlocked.mustChangePassword });
    }
    const cleanUser = String(username || '').trim();
    if (cleanUser.length < 3) throw new Error('Username must be at least 3 characters.');
    if (cleanUser.length > 40) throw new Error('Username must be 40 characters or fewer.');
    let oldKey = null;
    if (db.data.auth) {
      if (cleanUser !== db.data.auth.username) throw new Error('Use the existing username to migrate this app.');
      const legacyPassword = String(currentPassword || password || '');
      if (!bcrypt.compareSync(legacyPassword, db.data.auth.passwordHash)) {
        throw new Error('Enter the existing password to migrate this app.');
      }
      oldKey = deriveLegacyKey(legacyPassword, db.data.auth.kdfSalt);
    }
    const created = vault.create({ username: cleanUser, password });
    try {
      await encryptLegacyDatabase({
        db,
        filePath: DB_FILE,
        dek: created.dek,
        oldKey,
        sessionsRoot: SESSIONS_DIR
      });
      await finishUnlock(created.dek, { mustChangePassword: false });
    } catch (error) {
      vault.lock();
      throw error;
    }
    return { username: cleanUser, recoveryCode: created.recoveryCode };
  });

  handle('auth:login', async (username, password) => {
    if (!vault || !vault.exists()) throw new Error('No local login exists yet. Create one first.');
    const unlocked = vault.unlockWithPassword(username, password);
    return finishUnlock(unlocked.dek, { mustChangePassword: unlocked.mustChangePassword });
  });

  handle('auth:loginRecovery', async (recoveryCode) => {
    if (!vault || !vault.exists()) throw new Error('No local login exists yet. Create one first.');
    const unlocked = vault.unlockWithRecovery(recoveryCode);
    return finishUnlock(unlocked.dek, { mustChangePassword: false });
  });

  handle('auth:resetWithRecovery', async (recoveryCode, newPassword) => {
    if (!vault || !vault.exists()) throw new Error('No local login exists yet.');
    if (currentUser) throw new Error('Lock the app before resetting the password.');
    const reset = vault.resetWithRecovery(recoveryCode, newPassword);
    await finishUnlock(reset.dek, { mustChangePassword: false });
    return { username: currentUser, recoveryCode: reset.recoveryCode };
  });

  handle('auth:reauth', async (password) => {
    requireAuth();
    vault.verifyPassword(vault.getUsername(), password);
    lastAuthAt = Date.now();
    lastActivityAt = Date.now();
    return true;
  });

  handle('auth:changePassword', async (currentPassword, newPassword) => {
    requireAuth();
    const changed = vault.changePassword(currentPassword, newPassword);
    mustChangePassword = false;
    lastAuthAt = Date.now();
    return { recoveryCode: changed.recoveryCode };
  });

  handle('auth:regenerateRecovery', async (password) => {
    requireRecentAuth();
    const result = vault.regenerateRecovery(password);
    lastAuthAt = Date.now();
    return result;
  });

  handle('auth:lock', async () => {
    requireAuth();
    await lockApp();
    return true;
  });

  handle('auth:logoutApp', async () => {
    await lockApp();
    return true;
  });

  handle('app:snapshot', async () => {
    requireAuth();
    return snapshot();
  });

  handle('groups:fetchAvailable', async (accountId) => {
    requireAuth();
    const id = requiredId(accountId, 'Account');
    if (!db.findAccount(id)) throw new Error('Account not found.');
    return sessions.fetchGroups(id);
  });

  handle('groups:add', async (accountId, groupIds) => {
    requireRecentAuth();
    const id = requiredId(accountId, 'Account');
    if (!db.findAccount(id)) throw new Error('Account not found.');
    const ids = requireArray(groupIds, 'Groups', 500).map((groupId) => requiredId(groupId, 'Group'));
    const count = await sessions.addGroups(id, ids);
    broadcast('groups:update', db.data.groups.map(fullGroup));
    return { added: count };
  });

  handle('groups:get', async (groupId) => {
    requireAuth();
    const id = requiredId(groupId, 'Group');
    const group = db.findGroup(id);
    if (!group) throw new Error('Group not found.');
    await sessions.refreshGroup(id).catch(() => null);
    return fullGroup(db.findGroup(id));
  });

  handle('groups:refresh', async (groupId) => {
    requireAuth();
    const id = requiredId(groupId, 'Group');
    await sessions.refreshGroup(id, { strict: true });
    const group = db.findGroup(id);
    if (!group) throw new Error('Group not found.');
    return fullGroup(group);
  });

  handle('groups:deleteLocal', async (groupId) => {
    requireRecentAuth();
    const id = requiredId(groupId, 'Group');
    const group = db.findGroup(id);
    if (!group) throw new Error('Group not found.');
    queue.cancelJobsForGroup(id, 'Group removed from the app.');
    db.data.groups = db.data.groups.filter((item) => item.id !== id);
    db.save();
    broadcast('groups:update', db.data.groups.map(fullGroup));
    broadcast('jobs:update', serializeJobs());
    return true;
  });

  handle('members:context', async (groupId, mode) => {
    requireAuth();
    if (mode !== 'add' && mode !== 'remove') throw new Error('Unknown member action.');
    const id = requiredId(groupId, 'Group');
    await sessions.refreshGroup(id, { strict: true });
    const group = db.findGroup(id);
    if (!group) throw new Error('Group not found.');
    const pendingNumbers = [];
    const pendingTargets = [];
    for (const job of db.data.jobs) {
      if (job.groupId !== id || job.type !== mode) continue;
      if (job.status !== 'queued' && job.status !== 'running') continue;
      for (const target of job.targets || []) {
        if (target.status === 'pending' || target.status === 'running') {
          const jid = target.jid || target.number;
          pendingNumbers.push(jid);
          pendingTargets.push({
            key: target.jid || target.number,
            jid: target.jid || '',
            phoneNumber: target.phoneNumber || '',
            number: target.number || '',
            name: target.displayName || target.name || ''
          });
        }
      }
    }
    return {
      group: fullGroup(group),
      pendingNumbers,
      pendingTargets,
      mode
    };
  });

  handle('jobs:create', async (payload) => {
    requireRecentAuth();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid job request.');
    const groupId = requiredId(payload.groupId, 'Group');
    if (payload.type !== 'add' && payload.type !== 'remove') throw new Error('Unknown job type.');
    const numbers = requireArray(payload.numbers || [], 'Recipients', 5000);
    const targets = payload.targets === null || payload.targets === undefined
      ? null
      : requireArray(payload.targets, 'Recipients', 5000);
    const names = payload.names && typeof payload.names === 'object' && !Array.isArray(payload.names)
      ? payload.names
      : {};
    if (Object.keys(names).length > 5000) throw new Error('Too many recipient names.');
    await sessions.refreshGroup(groupId, { strict: true });
    const job = queue.createJob({
      type: payload.type,
      groupId,
      numbers,
      names,
      targets
    });
    return { id: job.id, total: job.targets.length };
  });

  handle('jobs:list', async () => {
    requireAuth();
    return serializeJobs();
  });

  handle('jobs:dismiss', async (jobId) => {
    requireAuth();
    return queue.dismissJob(requiredId(jobId, 'Job'));
  });

  handle('contacts:list', async () => {
    requireAuth();
    return serializeContacts();
  });

  handle('contacts:refresh', async () => {
    requireAuth();
    const result = await sessions.refreshAllContacts();
    return {
      contacts: serializeContacts(),
      count: db.data.contacts.length,
      synced: result.total,
      failed: result.failed
    };
  });

  handle('contacts:import', async (rows) => {
    requireRecentAuth();
    requireArray(rows, 'Contacts', 5000);
    const result = importContacts(db, rows);
    let namesChanged = 0;
    if (result.imported > 0) {
      namesChanged = db.refreshCachedDisplayNames(result.contacts);
      db.save();
      broadcast('contacts:update', { count: db.data.contacts.length });
      if (namesChanged > 0) {
        broadcast('groups:update', db.data.groups.map(fullGroup));
      }
    }
    return {
      imported: result.imported,
      named: result.named,
      unnamed: result.unnamed,
      skipped: result.skipped,
      count: db.data.contacts.length,
      namesChanged
    };
  });

  handle('accounts:list', async () => {
    requireAuth();
    return db.data.accounts.map(publicAccount);
  });

  handle('accounts:add', async (alias) => {
    requireRecentAuth();
    if (typeof alias !== 'string' || !alias.trim()) throw new Error('Give this account an alias.');
    const id = await sessions.addAccount(alias);
    return { id };
  });

  handle('accounts:relink', async (accountId) => {
    requireRecentAuth();
    const id = requiredId(accountId, 'Account');
    if (!db.findAccount(id)) throw new Error('Account not found.');
    await sessions.relinkAccount(id);
    return true;
  });

  handle('accounts:remove', async (accountId) => {
    requireRecentAuth();
    const id = requiredId(accountId, 'Account');
    if (!db.findAccount(id)) throw new Error('Account not found.');
    await sessions.removeAccount(id);
    broadcast('groups:update', db.data.groups.map(fullGroup));
    return true;
  });

  handle('settings:get', async () => {
    requireAuth();
    return db.data.settings;
  });

  handle('settings:update', async (patch) => {
    requireRecentAuth();
    const next = validateSettings(patch || {});
    db.data.settings = next;
    for (const account of db.data.accounts) {
      account.dailyActionLimit = next.dailyCap;
    }
    db.save();
    broadcast('settings:update', next);
    queue.kick();
    return next;
  });

  handle('import:parse', async (name, bytes) => {
    requireAuth();
    try {
      const parsed = parseSpreadsheet(name, bytes);
      return { rows: parsed.rows, stats: parsed.stats, fileName: String(name || 'spreadsheet') };
    } catch (error) {
      throw new Error(error.message || 'Could not read the spreadsheet.');
    }
  });

  handle('app:dataDir', async () => {
    requireAuth();
    return DATA_DIR;
  });
}

async function boot() {
  startupLog('Application starting');
  const stage = async (label, operation) => {
    const startedAt = Date.now();
    startupLog(`${label}...`);
    const result = await operation();
    startupLog(`${label} OK (${Date.now() - startedAt}ms)`);
    return result;
  };

  await stage('Initializing directories', () => {
    ensurePrivateDir(DATA_DIR);
    ensurePrivateDir(SESSIONS_DIR);
    contactDiagnostics.configure(DATA_DIR);
  });
  await stage('Loading local security vault', () => {
    vault = new AuthVault(VAULT_FILE);
    vault.load();
  });
  await stage('Loading database', () => {
    db = new Database(DB_FILE);
    let info = null;
    try {
      info = db.inspect();
    } catch (error) {
      let looksEncrypted = false;
      try {
        looksEncrypted = fs.readFileSync(DB_FILE, 'utf8').slice(0, 4096).includes('"wgm-encrypted-db"');
      } catch (_) {
        looksEncrypted = false;
      }
      if (looksEncrypted) {
        db.mode = 'locked';
        databaseState = 'encrypted';
        startupError('The encrypted database is unreadable; refusing to replace it', error);
        return;
      }
      info = null;
    }
    if (!info || info.kind === 'missing') {
      db.mode = 'locked';
      databaseState = 'locked';
      return;
    }
    if (info.kind === 'encrypted') {
      if (!vault.exists()) {
        startupError('An encrypted database exists without its local security vault', new Error('Missing auth-vault.json'));
      }
      db.mode = 'locked';
      databaseState = 'encrypted';
      return;
    }
    db.load();
    databaseState = db.mode;
  });
  await stage('Resetting daily counters', () => {
    if (db.mode !== 'locked') db.resetDailyCounters();
  });
  await stage('Initializing session manager', () => {
    sessions = new SessionManager({ db, sessionsRoot: SESSIONS_DIR });
  });
  await stage('Initializing queue manager', () => {
    queue = new QueueManager({ db, sessions });
  });
  await stage('Starting auto-lock', () => startAutoLockTimer());
  await stage('Wiring events', () => wireEvents());
  await stage('Registering IPC', () => registerIpc());
  await stage('Creating window', () => createWindow());
  startupLog('Application ready');
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    await boot();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((error) => {
    startupError('App boot failed', error);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    if (autoLockTimer) clearInterval(autoLockTimer);
    if (queue) queue.pause();
    const finish = () => app.quit();
    if (!sessions) {
      finish();
      return;
    }
    runWithTimeout(() => sessions.stopAll(), 5000).then((result) => {
      if (result.timedOut) {
        startupError('Graceful shutdown timed out; forcing exit', result.error);
        app.exit(0);
        return;
      }
      if (result.error) startupError('Session shutdown failed', result.error);
      finish();
    });
  });
}
