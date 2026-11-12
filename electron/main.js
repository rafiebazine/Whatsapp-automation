const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Database } = require('./db');
const { SessionManager, friendlyError } = require('./session-manager');
const {
  formatPhone,
  getContactDisplayName,
  hasActiveJobsForGroup
} = require('./identity');
const { QueueManager } = require('./queue');
const { parseSpreadsheet } = require('./spreadsheet');
const { runWithTimeout } = require('./lifecycle');

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
let sessions = null;
let queue = null;
let currentUser = null;
let quitting = false;

const DATA_DIR = process.env.WGM_DATA_DIR
  ? path.resolve(process.env.WGM_DATA_DIR)
  : app.getPath('userData');
const DB_FILE = path.join(DATA_DIR, 'whatsapp-group-manager.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

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

function deriveKey(password, saltHex) {
  return Buffer.from(crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32));
}

function requireAuth() {
  if (!currentUser) throw new Error('Please log in first.');
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
    members: (group.members || []).slice().sort((a, b) => {
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
    hasUser: Boolean(db.data.auth),
    authenticated: Boolean(currentUser),
    user: currentUser,
    accounts: db.data.accounts.map(publicAccount),
    groups: db.data.groups.map(groupSummary),
    jobs: serializeJobs(),
    settings: db.data.settings,
    contactsCount: db.data.contacts.length
  };
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const data = await handler(...args);
      return { ok: true, data };
    } catch (error) {
      console.error(`IPC ${channel} failed:`, error);
      return { ok: false, error: friendlyError(error) };
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
    failurePauseThreshold: [1, 20]
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
      sandbox: false,
      spellcheck: false
    }
  });
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

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html')).catch((error) => {
    startupError('loadFile failed', error);
    showWindowLoadError(error && error.message ? error.message : 'The application files could not be loaded.');
    showWindow('loadFile-catch');
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
  handle('auth:status', async () => ({
    hasUser: Boolean(db.data.auth),
    authenticated: Boolean(currentUser),
    username: currentUser,
    dataDir: DATA_DIR
  }));

  handle('auth:setup', async (username, password) => {
    if (db.data.auth) throw new Error('A local login already exists.');
    const cleanUser = String(username || '').trim();
    if (cleanUser.length < 3) throw new Error('Username must be at least 3 characters.');
    if (cleanUser.length > 40) throw new Error('Username must be 40 characters or fewer.');
    if (String(password || '').length < 6) throw new Error('Password must be at least 6 characters.');
    const saltHex = crypto.randomBytes(16).toString('hex');
    db.data.auth = {
      username: cleanUser,
      passwordHash: bcrypt.hashSync(password, 12),
      kdfSalt: saltHex,
      createdAt: new Date().toISOString()
    };
    db.save();
    currentUser = cleanUser;
    sessions.setMasterKey(deriveKey(password, saltHex));
    startupLog('Local login created; starting sessions in background');
    sessions.startAll().catch((error) => {
      startupError('Failed to start sessions after setup', error);
    });
    queue.start();
    broadcast('auth:changed', { authenticated: true });
    return { username: cleanUser };
  });

  handle('auth:login', async (username, password) => {
    if (!db.data.auth) throw new Error('No local login exists yet. Create one first.');
    const validUser = String(username || '').trim() === db.data.auth.username;
    const validPassword = bcrypt.compareSync(String(password || ''), db.data.auth.passwordHash);
    if (!validUser || !validPassword) throw new Error('Incorrect username or password.');
    currentUser = db.data.auth.username;
    sessions.setMasterKey(deriveKey(String(password), db.data.auth.kdfSalt));
    startupLog('Login accepted; starting sessions in background');
    sessions.startAll().catch((error) => {
      startupError('Failed to start sessions after login', error);
    });
    queue.start();
    broadcast('auth:changed', { authenticated: true });
    return { username: currentUser };
  });

  handle('auth:logoutApp', async () => {
    queue.pause();
    await sessions.stopAll();
    currentUser = null;
    broadcast('auth:changed', { authenticated: false });
    return true;
  });

  handle('app:snapshot', async () => {
    requireAuth();
    return snapshot();
  });

  handle('groups:fetchAvailable', async (accountId) => {
    requireAuth();
    return sessions.fetchGroups(accountId);
  });

  handle('groups:add', async (accountId, groupIds) => {
    requireAuth();
    const count = await sessions.addGroups(accountId, groupIds);
    broadcast('groups:update', db.data.groups.map(fullGroup));
    return { added: count };
  });

  handle('groups:get', async (groupId) => {
    requireAuth();
    const group = db.findGroup(groupId);
    if (!group) throw new Error('Group not found.');
    await sessions.refreshGroup(groupId).catch(() => null);
    return fullGroup(db.findGroup(groupId));
  });

  handle('groups:refresh', async (groupId) => {
    requireAuth();
    await sessions.refreshGroup(groupId, { strict: true });
    return fullGroup(db.findGroup(groupId));
  });

  handle('groups:deleteLocal', async (groupId) => {
    requireAuth();
    const group = db.findGroup(groupId);
    if (!group) throw new Error('Group not found.');
    queue.cancelJobsForGroup(groupId, 'Group removed from the app.');
    db.data.groups = db.data.groups.filter((item) => item.id !== groupId);
    db.save();
    broadcast('groups:update', db.data.groups.map(fullGroup));
    broadcast('jobs:update', serializeJobs());
    return true;
  });

  handle('members:context', async (groupId, mode) => {
    requireAuth();
    if (mode !== 'add' && mode !== 'remove') throw new Error('Unknown member action.');
    await sessions.refreshGroup(groupId, { strict: true });
    const group = db.findGroup(groupId);
    if (!group) throw new Error('Group not found.');
    const pendingNumbers = [];
    const pendingTargets = [];
    for (const job of db.data.jobs) {
      if (job.groupId !== groupId || job.type !== mode) continue;
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
    requireAuth();
    if (!payload || typeof payload !== 'object') throw new Error('Invalid job request.');
    await sessions.refreshGroup(payload.groupId, { strict: true });
    const job = queue.createJob({
      type: payload.type,
      groupId: payload.groupId,
      numbers: payload.numbers || [],
      names: payload.names || {},
      targets: payload.targets || null
    });
    return { id: job.id, total: job.targets.length };
  });

  handle('jobs:list', async () => {
    requireAuth();
    return serializeJobs();
  });

  handle('jobs:dismiss', async (jobId) => {
    requireAuth();
    return queue.dismissJob(jobId);
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

  handle('accounts:list', async () => {
    requireAuth();
    return db.data.accounts.map(publicAccount);
  });

  handle('accounts:add', async (alias) => {
    requireAuth();
    const id = await sessions.addAccount(alias);
    return { id };
  });

  handle('accounts:relink', async (accountId) => {
    requireAuth();
    await sessions.relinkAccount(accountId);
    return true;
  });

  handle('accounts:remove', async (accountId) => {
    requireAuth();
    await sessions.removeAccount(accountId);
    broadcast('groups:update', db.data.groups.map(fullGroup));
    return true;
  });

  handle('settings:get', async () => {
    requireAuth();
    return db.data.settings;
  });

  handle('settings:update', async (patch) => {
    requireAuth();
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
  const stage = (label, operation) => {
    const startedAt = Date.now();
    startupLog(`${label}...`);
    const result = operation();
    startupLog(`${label} OK (${Date.now() - startedAt}ms)`);
    return result;
  };

  stage('Initializing directories', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  });
  stage('Loading database', () => {
    db = new Database(DB_FILE);
    db.load();
  });
  stage('Resetting daily counters', () => db.resetDailyCounters());
  stage('Initializing session manager', () => {
    sessions = new SessionManager({ db, sessionsRoot: SESSIONS_DIR });
  });
  stage('Initializing queue manager', () => {
    queue = new QueueManager({ db, sessions });
  });
  stage('Wiring events', () => wireEvents());
  stage('Registering IPC', () => registerIpc());
  stage('Creating window', () => createWindow());
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
