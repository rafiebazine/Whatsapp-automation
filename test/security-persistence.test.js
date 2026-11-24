const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Database } = require('../electron/db');
const { AuthVault } = require('../electron/vault');
const { useEncryptedAuthState } = require('../electron/auth-store');
const { SessionManager } = require('../electron/session-manager');
const { QueueManager } = require('../electron/queue');
const { writeFileAtomicPrivate } = require('../electron/secure-fs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-persistence-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function failingWriter(error) {
  return () => {
    throw error;
  };
}

test('database save failures are reported and rolled back', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'db.json');
    let fail = false;
    const writer = (target, data) => {
      if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return writeFileAtomicPrivate(target, data);
    };
    const db = new Database(file, { writeFileAtomicPrivate: writer });
    db.load();
    db.data.settings.dailyCap = 33;
    db.saveOrThrow();

    fail = true;
    assert.equal(db.save(), false);
    assert.equal(db.hasPersistenceError(), true);
    assert.throws(() => db.addAccount('Second'), (error) => error.code === 'db_persist_failed');
    assert.equal(db.data.accounts.length, 0);
    assert.throws(() => db.transaction((data) => {
      data.settings.dailyCap = 99;
    }), (error) => error.code === 'db_persist_failed');
    assert.equal(db.data.settings.dailyCap, 33);

    fail = false;
    db.saveOrThrow();
    const reopened = new Database(file);
    reopened.load();
    assert.equal(reopened.data.settings.dailyCap, 33);
    assert.equal(reopened.data.accounts.length, 0);
    assert.equal(reopened.hasPersistenceError(), false);
  } finally {
    cleanup(dir);
  }
});

test('database refuses to replace a file on non-corruption read errors', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'db.json');
    const db = new Database(file);
    db.load();
    const before = fs.readFileSync(file, 'utf8');
    const blocked = new Database(file, {
      readFileSync: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
    });
    assert.throws(() => blocked.load(), (error) => error.code === 'EACCES');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.readdirSync(dir).some((name) => name.includes('.corrupt-')), false);
  } finally {
    cleanup(dir);
  }
});

test('vault create failure leaves no phantom vault and preserves the old password', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'auth-vault.json');
    let fail = false;
    const writer = (target, data) => {
      if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return writeFileAtomicPrivate(target, data);
    };
    const vault = new AuthVault(file, { scryptN: 1024, bcryptRounds: 4, writeFile: writer });
    fail = true;
    assert.throws(
      () => vault.create({ username: 'operator', password: 'correct horse battery staple' }),
      (error) => error.code === 'vault_persist_failed'
    );
    assert.equal(vault.exists(), false);
    assert.equal(vault.state, null);
    assert.equal(fs.existsSync(file), false);

    fail = false;
    vault.create({ username: 'operator', password: 'correct horse battery staple' });
    fail = true;
    assert.throws(
      () => vault.changePassword('correct horse battery staple', 'another long password here'),
      (error) => error.code === 'vault_persist_failed'
    );
    fail = false;
    assert.equal(vault.unlockWithPassword('operator', 'correct horse battery staple').dek.length, 32);
  } finally {
    cleanup(dir);
  }
});

test('vault lockout state is rolled back when it cannot be persisted', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'auth-vault.json');
    let fail = false;
    const writer = (target, data) => {
      if (fail) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return writeFileAtomicPrivate(target, data);
    };
    const vault = new AuthVault(file, { scryptN: 1024, bcryptRounds: 4, writeFile: writer });
    vault.create({ username: 'operator', password: 'correct horse battery staple' });
    fail = true;
    assert.throws(
      () => vault.unlockWithPassword('operator', 'wrong password'),
      (error) => error.code === 'vault_persist_failed'
    );
    assert.equal(vault.state.security.failedAttempts, 0);
  } finally {
    cleanup(dir);
  }
});

test('auth-state write failure rejects and preserves the previous encrypted file', async () => {
  const dir = tempDir();
  try {
    const folder = path.join(dir, 'acc_1');
    const key = crypto.randomBytes(32);
    const auth = await useEncryptedAuthState(folder, key, 'acc_1', { retries: 0 });
    const file = path.join(folder, 'auth.enc');
    const before = fs.readFileSync(file, 'utf8');
    await assert.rejects(
      () => useEncryptedAuthState(folder, key, 'acc_1', {
        retries: 0,
        writeFileAtomicPrivate: failingWriter(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
      }),
      (error) => error.code === 'auth_persist_failed'
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const reopened = await useEncryptedAuthState(folder, key, 'acc_1', { retries: 0 });
    assert.ok(reopened.state.creds);
  } finally {
    cleanup(dir);
  }
});

test('auth-state serialization and encryption failures reject', async () => {
  const dir = tempDir();
  try {
    const folder = path.join(dir, 'acc_1');
    const key = crypto.randomBytes(32);
    await assert.rejects(
      () => useEncryptedAuthState(folder, key, 'acc_1', {
        retries: 0,
        encryptJson: () => {
          throw new Error('cipher unavailable');
        }
      }),
      (error) => error.code === 'auth_persist_failed'
    );
    await assert.rejects(
      () => useEncryptedAuthState(folder, key, 'acc_1', {
        retries: 0,
        encryptJson: () => ({ bad: 1n })
      }),
      (error) => error.code === 'auth_persist_failed'
    );
  } finally {
    cleanup(dir);
  }
});

test('session start aborts and marks relink when auth-state persistence fails', async () => {
  const account = {
    id: 'acc_1',
    alias: 'One',
    authFolder: 'acc_1',
    status: 'disconnected',
    needsRelink: false
  };
  const db = {
    data: { accounts: [account], settings: {} },
    findAccount: (id) => (account.id === id ? account : null),
    saveOrThrow() {},
    saveBestEffort() { return true; },
    reportPersistenceError() {}
  };
  const manager = new SessionManager({
    db,
    sessionsRoot: '/tmp/wgm-persistence-sessions',
    createAuthState: async () => {
      const error = new Error('The encrypted session state could not be saved to disk.');
      error.code = 'auth_persist_failed';
      throw error;
    }
  });
  manager.setMasterKey(crypto.randomBytes(32));
  await assert.rejects(() => manager.startAccount('acc_1'), (error) => error.code === 'auth_persist_failed');
  assert.equal(account.status, 'disconnected');
  assert.equal(account.needsRelink, true);
  assert.match(account.lastError, /could not be saved/);
});

test('queue job creation rolls back when persistence fails', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'db.json');
    let fail = false;
    const writer = (target, data) => {
      if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return writeFileAtomicPrivate(target, data);
    };
    const db = new Database(file, { writeFileAtomicPrivate: writer });
    db.load();
    const group = {
      id: '120363000000000000@g.us',
      name: 'Group',
      adminIds: ['111@lid'],
      adminAccountIds: [],
      members: [{ id: '111@lid', lid: '111@lid', isAdmin: true }],
      hasOngoingAction: false,
      hasError: false
    };
    db.data.groups.push(group);
    db.saveOrThrow();
    const sessions = {
      isConnected: () => false,
      isVerifiedAdminOf: () => false,
      sendAction: async () => {
        throw new Error('must not send');
      }
    };
    const queue = new QueueManager({ db, sessions });
    fail = true;
    assert.throws(
      () => queue.createJob({ type: 'add', groupId: group.id, numbers: ['212600000001'], names: {}, targets: null }),
      (error) => error.code === 'db_persist_failed'
    );
    assert.equal(db.data.jobs.length, 0);
    assert.equal(db.data.groups[0].hasOngoingAction, false);
  } finally {
    cleanup(dir);
  }
});

test('queue execute aborts before sending when progress cannot be persisted', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'db.json');
    let fail = false;
    const writer = (target, data) => {
      if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return writeFileAtomicPrivate(target, data);
    };
    const db = new Database(file, { writeFileAtomicPrivate: writer });
    db.load();
    const account = {
      id: 'acc_1',
      alias: 'One',
      status: 'connected',
      dailyActionCount: 0,
      dailyActionLimit: 20,
      batchCount: 0,
      consecutiveFailures: 0
    };
    const group = { id: 'group@g.us', name: 'Group', adminIds: [], adminAccountIds: [], members: [] };
    const target = { jid: '212600000001@s.whatsapp.net', number: '212600000001', status: 'pending', attempts: 0 };
    const job = {
      id: 'job_1',
      type: 'add',
      groupId: group.id,
      groupName: group.name,
      status: 'queued',
      targets: [target],
      errors: []
    };
    db.data.accounts.push(account);
    db.data.groups.push(group);
    db.data.jobs.push(job);
    db.saveOrThrow();
    let sent = 0;
    const queue = new QueueManager({
      db,
      sessions: {
        isConnected: () => true,
        isVerifiedAdminOf: () => true,
        sendAction: async () => {
          sent += 1;
          return [{ status: 'success' }];
        }
      }
    });
    fail = true;
    await assert.rejects(
      () => queue.execute(job, target, account, group),
      (error) => error.code === 'db_persist_failed'
    );
    assert.equal(sent, 0);
    assert.equal(target.status, 'pending');
    assert.equal(target.attempts, 0);
    assert.equal(job.status, 'queued');
  } finally {
    cleanup(dir);
  }
});
