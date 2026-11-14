const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../electron/db');
const { SessionManager } = require('../electron/session-manager');
const { loadBaileys } = require('../electron/baileys-loader');

function makeManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-app-state-resync-'));
  const db = new Database(path.join(dir, 'data.json'));
  db.load();
  const manager = new SessionManager({ db, sessionsRoot: path.join(dir, 'sessions') });
  return { db, dir, manager };
}

function addAccount(db, id) {
  db.data.accounts.push({
    id,
    alias: id,
    authFolder: id,
    phoneNumber: '',
    whatsappId: '',
    whatsappJid: '',
    whatsappLid: '',
    status: 'connected'
  });
}

function makeEntry(manager, accountId, options = {}) {
  const calls = [];
  const keyWrites = [];
  const entry = {
    connected: true,
    appStatePatchNames: options.patchNames || ['critical_unblock_low', 'regular'],
    appStateResyncStatus: 'pending',
    authKeys: options.authKeys === undefined
      ? {
          set: async (value) => {
            keyWrites.push(value);
          }
        }
      : options.authKeys,
    sock: {
      resyncAppState: async (collections, initialSync) => {
        calls.push({ collections, initialSync });
        if (options.onResync) {
          await options.onResync({ entry, calls, manager, accountId, collections, initialSync });
        }
      }
    }
  };
  if (options.noResync) delete entry.sock.resyncAppState;
  manager.sockets.set(accountId, entry);
  return { entry, calls, keyWrites };
}

function contact(id, name, extra = {}) {
  return { id, jid: id.endsWith('@s.whatsapp.net') ? id : '', name, ...extra };
}

test('Baileys 6.7.24 exposes ALL_WA_PATCH_NAMES and includes the contact collection', async () => {
  const baileys = await loadBaileys();
  assert.ok(Array.isArray(baileys.ALL_WA_PATCH_NAMES));
  assert.ok(baileys.ALL_WA_PATCH_NAMES.includes('critical_unblock_low'));
});

test('resync invokes Baileys with patch names and isInitialSync true', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    const { entry, calls } = makeEntry(manager, 'acc_1', {
      onResync: async ({ manager: sessionManager, accountId }) => {
        await sessionManager.handleContactsUpsert(accountId, [
          contact('212600000001@s.whatsapp.net', 'Saved Contact')
        ]);
      }
    });

    const stats = await manager.resyncAccountAppState('acc_1');
    assert.deepEqual(calls[0], {
      collections: ['critical_unblock_low', 'regular'],
      initialSync: true
    });
    assert.equal(stats.status, 'completed');
    assert.equal(stats.contactsUpsertEvents, 1);
    assert.equal(stats.contactsReceived, 1);
    assert.equal(stats.namedContactsReceived, 1);
    assert.equal(stats.uniqueContacts, 1);
    assert.equal(stats.namedRecovered, 1);
    assert.equal(stats.namedPersisted, 1);
    assert.equal(db.data.contacts.length, 1);
    assert.equal(db.contactName({ phoneNumber: '212600000001' }), 'Saved Contact');
    assert.equal(entry.appStateResyncStatus, 'completed');
    assert.equal(entry.connected, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate open events do not start a second resync for the same socket', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { calls } = makeEntry(manager, 'acc_1', {
      onResync: async () => {
        await gate;
      }
    });

    const first = manager.resyncAccountAppState('acc_1');
    const second = manager.resyncAccountAppState('acc_1');
    assert.strictEqual(first, second);
    assert.equal(calls.length, 1);
    release();
    await first;
    assert.equal(calls.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('multiple accounts keep independent app-state resync state', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    addAccount(db, 'acc_2');
    const first = makeEntry(manager, 'acc_1');
    const second = makeEntry(manager, 'acc_2');

    const [firstStats, secondStats] = await Promise.all([
      manager.resyncAccountAppState('acc_1'),
      manager.resyncAccountAppState('acc_2')
    ]);

    assert.equal(first.calls.length, 1);
    assert.equal(second.calls.length, 1);
    assert.equal(firstStats.accountId, 'acc_1');
    assert.equal(secondStats.accountId, 'acc_2');
    assert.equal(first.entry.appStateResyncStarted, true);
    assert.equal(second.entry.appStateResyncStarted, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('app-state contact names persist without overwriting local names or erasing valid names', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    const identity = {
      id: '212600000002@s.whatsapp.net',
      jid: '212600000002@s.whatsapp.net',
      phoneNumber: '212600000002'
    };
    db.upsertContactIdentity(identity, 'Local Name', 'acc_1', 'manual', 'local');
    db.upsertContactIdentity(
      { id: '212600000003@s.whatsapp.net', jid: '212600000003@s.whatsapp.net', phoneNumber: '212600000003' },
      'Existing Saved Name',
      'acc_1',
      'contact',
      'whatsapp'
    );
    makeEntry(manager, 'acc_1');

    await manager.handleContactsUpsert('acc_1', [
      contact('212600000002@s.whatsapp.net', 'Saved Name'),
      contact('212600000003@s.whatsapp.net', '')
    ]);

    assert.equal(db.contactName({ phoneNumber: '212600000002' }), 'Local Name');
    assert.equal(db.findContact({ phoneNumber: '212600000002' }).nameSource, 'local');
    assert.equal(db.contactName({ phoneNumber: '212600000003' }), 'Existing Saved Name');
    assert.equal(db.data.contacts.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('app-state contact ingestion enriches matching group members', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    const phone = '212600000004@s.whatsapp.net';
    db.data.groups.push({
      id: '120363000000000000@g.us',
      name: 'Group',
      adminIds: [],
      adminAccountIds: [],
      members: [
        { id: phone, jid: phone, phoneNumber: '212600000004', displayName: '', isAdmin: false }
      ]
    });
    makeEntry(manager, 'acc_1');

    await manager.handleContactsUpsert('acc_1', [contact(phone, 'Group Member Name')]);

    assert.equal(db.data.groups[0].members[0].displayName, 'Group Member Name');
    assert.equal(db.contactName({ phoneNumber: '212600000004' }), 'Group Member Name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('forced critical_unblock_low snapshot runs only when plain resync emits no contacts', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    const phone = '212600000005@s.whatsapp.net';
    db.upsertContactIdentity({ id: phone, jid: phone, phoneNumber: '212600000005' }, '', 'acc_1', 'group', 'participant');
    const { entry, calls, keyWrites } = makeEntry(manager, 'acc_1', {
      onResync: async ({ manager: sessionManager, accountId, calls: currentCalls }) => {
        if (currentCalls.length === 2) {
          await sessionManager.handleContactsUpsert(accountId, [contact(phone, 'Recovered Name')]);
        }
      }
    });

    const stats = await manager.resyncAccountAppState('acc_1');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].collections, ['critical_unblock_low', 'regular']);
    assert.deepEqual(calls[1].collections, ['critical_unblock_low']);
    assert.deepEqual(keyWrites[0], {
      'app-state-sync-version': { critical_unblock_low: null }
    });
    assert.equal(stats.forcedSnapshot, true);
    assert.equal(stats.status, 'completed');
    assert.equal(db.contactName({ phoneNumber: '212600000005' }), 'Recovered Name');
    assert.equal(entry.appStateResyncForcedSnapshot, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('forced snapshot is not repeated for the same account within one process', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    db.upsertContactIdentity(
      { id: '212600000007@s.whatsapp.net', jid: '212600000007@s.whatsapp.net', phoneNumber: '212600000007' },
      '',
      'acc_1',
      'group',
      'participant'
    );
    const first = makeEntry(manager, 'acc_1');
    const firstStats = await manager.resyncAccountAppState('acc_1');
    assert.equal(firstStats.forcedSnapshot, true);
    assert.equal(first.calls.length, 2);
    assert.equal(manager.appStateForcedSnapshots.has('acc_1'), true);

    manager.sockets.delete('acc_1');
    const second = makeEntry(manager, 'acc_1');
    const secondStats = await manager.resyncAccountAppState('acc_1');
    assert.equal(secondStats.forcedSnapshot, false);
    assert.equal(second.calls.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing API capabilities fail clearly without disconnecting the account', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    const { entry } = makeEntry(manager, 'acc_1', { patchNames: [] });
    const stats = await manager.resyncAccountAppState('acc_1');
    assert.equal(stats.status, 'failed');
    assert.match(stats.error, /ALL_WA_PATCH_NAMES/);
    assert.equal(entry.connected, true);
    assert.equal(entry.appStateResyncStatus, 'failed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing socket method fails clearly without disconnecting the account', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    const { entry } = makeEntry(manager, 'acc_1', { noResync: true });
    const stats = await manager.resyncAccountAppState('acc_1');
    assert.equal(stats.status, 'failed');
    assert.match(stats.error, /resyncAppState/);
    assert.equal(entry.connected, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejected resync and disconnection are reported as failures without retry loops', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    const { entry } = makeEntry(manager, 'acc_1', {
      onResync: async () => {
        throw new Error('app state unavailable');
      }
    });
    const stats = await manager.resyncAccountAppState('acc_1');
    assert.equal(stats.status, 'failed');
    assert.match(stats.error, /app state unavailable/);
    assert.equal(entry.connected, true);

    const second = await manager.resyncAccountAppState('acc_1');
    assert.strictEqual(second, stats);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('disconnect during resync fails instead of reporting success', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    const { entry } = makeEntry(manager, 'acc_1', {
      onResync: async () => {
        entry.connected = false;
      }
    });
    const stats = await manager.resyncAccountAppState('acc_1');
    assert.equal(stats.status, 'failed');
    assert.match(stats.error, /disconnected/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('forced snapshot requires encrypted auth keys', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    db.upsertContactIdentity(
      { id: '212600000006@s.whatsapp.net', jid: '212600000006@s.whatsapp.net', phoneNumber: '212600000006' },
      '',
      'acc_1',
      'group',
      'participant'
    );
    makeEntry(manager, 'acc_1', { authKeys: null });
    const stats = await manager.resyncAccountAppState('acc_1');
    assert.equal(stats.status, 'failed');
    assert.match(stats.error, /auth keys/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
