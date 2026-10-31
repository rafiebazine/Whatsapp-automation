const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const { Database } = require('./db');
const { SessionManager, friendlyError, normalizePhone } = require('./session-manager');
const { QueueManager } = require('./queue');

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
    hasOngoingAction: group.hasOngoingAction,
    hasError: group.hasError,
    adminIds: group.adminIds || [],
    adminAccountIds: group.adminAccountIds || []
  };
}

function fullGroup(group) {
  return {
    ...groupSummary(group),
    members: (group.members || []).slice().sort((a, b) => {
      const aName = (a.displayName || a.phoneNumber).toLowerCase();
      const bName = (b.displayName || b.phoneNumber).toLowerCase();
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
    .map((contact) => ({
      phoneNumber: contact.phoneNumber,
      name: contact.name || '',
      sourceAccounts: (contact.sourceAccounts || [])
        .map((id) => {
          const account = db.findAccount(id);
          return account ? account.alias : null;
        })
        .filter(Boolean),
      lastSyncedAt: contact.lastSyncedAt
    }))
    .sort((a, b) => (a.name || a.phoneNumber).localeCompare(b.name || b.phoneNumber));
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

function parseSpreadsheet(name, bytes) {
  if (!bytes) throw new Error('The selected file is empty.');
  const buffer = Buffer.from(bytes);
  if (buffer.length > 8 * 1024 * 1024) throw new Error('The file is too large. Use a file under 8 MB.');
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', raw: true, cellDates: false });
  } catch (error) {
    throw new Error('This file could not be read. Use a valid .xlsx or .csv file.');
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('The spreadsheet has no sheets.');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    blankrows: false,
    raw: true,
    defval: ''
  });
  if (!rows.length) return [];
  const first = rows[0].map((cell) => String(cell || '').toLowerCase().trim());
  const looksLikeHeader =
    first.some((cell) => /number|phone|telephone|num[eé]ro|mobile/.test(cell)) &&
    first.some((cell) => /name|nom/.test(cell));
  const dataRows = looksLikeHeader ? rows.slice(1) : rows;
  const result = [];
  for (const row of dataRows.slice(0, 5000)) {
    const number = normalizePhone(row[0]);
    const rawName = String(row[1] || '').trim();
    if (!number && !rawName) continue;
    result.push({ number: String(row[0] || '').trim(), name: rawName });
  }
  return result;
}

function createWindow() {
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
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('closed', () => {
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
    await sessions.startAll();
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
    await sessions.startAll();
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
    for (const job of db.data.jobs) {
      if (job.groupId !== groupId || job.type !== mode) continue;
      if (job.status !== 'queued' && job.status !== 'running') continue;
      for (const target of job.targets || []) {
        if (target.status === 'pending' || target.status === 'running') pendingNumbers.push(target.number);
      }
    }
    return {
      group: fullGroup(group),
      pendingNumbers,
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
      names: payload.names || {}
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
    await sessions.refreshAllContacts();
    return { contacts: serializeContacts(), count: db.data.contacts.length };
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
      const rows = parseSpreadsheet(name, bytes);
      return { rows, fileName: String(name || 'spreadsheet') };
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
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.load();
  db.resetDailyCounters();
  sessions = new SessionManager({ db, sessionsRoot: SESSIONS_DIR });
  queue = new QueueManager({ db, sessions });
  wireEvents();
  registerIpc();
  createWindow();
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
    console.error('App boot failed:', error);
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
    if (sessions) {
      sessions.stopAll().then(finish).catch(finish);
    } else {
      finish();
    }
  });
}
