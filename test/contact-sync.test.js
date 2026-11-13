const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../electron/db');
const { SessionManager } = require('../electron/session-manager');

function makeManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-contact-sync-test-'));
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

function connect(manager, accountId, groups) {
  manager.sockets.set(accountId, {
    connected: true,
    sock: {
      groupFetchAllParticipating: async () => groups
    }
  });
}

function lidParticipant(index, name) {
  const id = `${1000000000 + index}@lid`;
  return { id, lid: id, name: name || `LID ${index}` };
}

function pnParticipant(index, name) {
  const phoneNumber = `2126${String(index).padStart(8, '0')}`;
  const id = `${phoneNumber}@s.whatsapp.net`;
  return { id, jid: id, phoneNumber, name: name || `PN ${index}` };
}

test('deduplicates repeated participants and keeps repeated syncs idempotent', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    const participants = [lidParticipant(1, 'One'), pnParticipant(2, 'Two')];
    connect(manager, 'acc_1', {
      'group-1@g.us': { participants },
      'group-2@g.us': { participants }
    });

    const firstCount = await manager.syncContacts('acc_1');
    const first = manager.lastContactSyncStats;
    assert.equal(firstCount, 2);
    assert.equal(first.participantOccurrences, 4);
    assert.equal(first.uniqueParticipants, 2);
    assert.equal(first.created, 2);
    assert.equal(first.updated, 0);
    assert.equal(db.data.contacts.length, 2);

    const secondCount = await manager.syncContacts('acc_1');
    const second = manager.lastContactSyncStats;
    assert.equal(secondCount, 2);
    assert.equal(second.created, 0);
    assert.equal(second.updated, 2);
    assert.equal(second.contactsAdded, 0);
    assert.equal(db.data.contacts.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shares PN contacts across accounts without merging distinct LID identities', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    addAccount(db, 'acc_2');
    const phone = pnParticipant(7, 'Phone contact');
    const lidId = `${phone.phoneNumber}@lid`;
    connect(manager, 'acc_1', {
      'group-1@g.us': { participants: [phone] }
    });
    connect(manager, 'acc_2', {
      'group-2@g.us': {
        participants: [
          pnParticipant(7, 'Phone contact'),
          { id: lidId, lid: lidId, phoneNumber: '', name: 'LID contact' }
        ]
      }
    });

    await manager.syncContacts('acc_1');
    await manager.syncContacts('acc_2');

    assert.equal(db.data.contacts.length, 2);
    const phoneContact = db.findContact({ phoneNumber: phone.phoneNumber });
    const lidContact = db.findContact({ lid: lidId });
    assert.notEqual(phoneContact, lidContact);
    assert.deepEqual(phoneContact.sourceAccounts, ['acc_1', 'acc_2']);
    assert.deepEqual(lidContact.sourceAccounts, ['acc_2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('processes 10,000 participants in bounded batches and yields to the event loop', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    manager.contactSyncBatchSize = 250;
    const groups = {};
    let participantIndex = 0;
    for (let groupIndex = 0; groupIndex < 100; groupIndex += 1) {
      const participants = [];
      for (let memberIndex = 0; memberIndex < 100; memberIndex += 1) {
        participants.push(lidParticipant(participantIndex));
        participantIndex += 1;
      }
      groups[`group-${groupIndex}@g.us`] = { participants };
    }
    connect(manager, 'acc_1', groups);

    const count = await manager.syncContacts('acc_1');
    const stats = manager.lastContactSyncStats;
    assert.equal(count, 10000);
    assert.equal(stats.participantOccurrences, 10000);
    assert.equal(stats.uniqueParticipants, 10000);
    assert.equal(stats.created, 10000);
    assert.equal(stats.yields, 39);
    assert.equal(db.data.contacts.length, 10000);
    assert.ok(stats.durationMs < 10000, `sync took ${stats.durationMs}ms`);
    assert.equal(db.getContactIndexStats().contactsScanned, 0);

    await manager.syncContacts('acc_1');
    const repeated = manager.lastContactSyncStats;
    assert.equal(repeated.created, 0);
    assert.equal(repeated.updated, 10000);
    assert.equal(repeated.contactsAdded, 0);
    assert.ok(repeated.indexHits >= 10000);
    assert.equal(db.getContactIndexStats().contactsScanned, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serializes concurrent contact ingests and batches each ingest', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    manager.contactSyncBatchSize = 250;
    const firstBatch = Array.from({ length: 300 }, (_, index) => lidParticipant(index, `First ${index}`));
    const secondBatch = Array.from({ length: 300 }, (_, index) => lidParticipant(300 + index, `Second ${index}`));
    firstBatch.push(firstBatch[0]);

    const [firstCount, secondCount] = await Promise.all([
      manager.ingestContacts('acc_1', firstBatch),
      manager.ingestContacts('acc_1', secondBatch)
    ]);

    assert.equal(firstCount, 300);
    assert.equal(secondCount, 300);
    assert.equal(db.data.contacts.length, 600);
    assert.equal(manager.lastContactIngestStats.received, 300);
    assert.equal(manager.lastContactIngestStats.yields, 1);
    assert.equal(db.findContact({ lid: '1000000300@lid' }).name, 'Second 0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function groupsForContacts(count) {
  const groups = {};
  let index = 0;
  let groupIndex = 0;
  while (index < count) {
    const participants = [];
    const groupSize = Math.min(100, count - index);
    for (let memberIndex = 0; memberIndex < groupSize; memberIndex += 1) {
      participants.push(lidParticipant(index));
      index += 1;
    }
    groups[`scale-group-${groupIndex}@g.us`] = { participants };
    groupIndex += 1;
  }
  return groups;
}

test('scales near-linearly from 2,000 to 4,000 unique contacts', async () => {
  const small = makeManager();
  const large = makeManager();
  try {
    addAccount(small.db, 'acc_1');
    addAccount(large.db, 'acc_1');
    small.manager.contactSyncBatchSize = 250;
    large.manager.contactSyncBatchSize = 250;
    connect(small.manager, 'acc_1', groupsForContacts(2000));
    connect(large.manager, 'acc_1', groupsForContacts(4000));

    await small.manager.syncContacts('acc_1');
    await large.manager.syncContacts('acc_1');

    assert.equal(small.db.data.contacts.length, 2000);
    assert.equal(large.db.data.contacts.length, 4000);
    assert.equal(small.db.getContactIndexStats().contactsScanned, 0);
    assert.equal(large.db.getContactIndexStats().contactsScanned, 0);
    assert.ok(
      large.manager.lastContactSyncStats.durationMs < small.manager.lastContactSyncStats.durationMs * 8 + 1000,
      `4,000 contacts took ${large.manager.lastContactSyncStats.durationMs}ms vs ${small.manager.lastContactSyncStats.durationMs}ms`
    );
  } finally {
    fs.rmSync(small.dir, { recursive: true, force: true });
    fs.rmSync(large.dir, { recursive: true, force: true });
  }
});

test('returns zero contact work when an account is offline', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    manager.sockets.set('acc_1', { connected: false, sock: {} });
    assert.equal(await manager.syncContacts('acc_1'), 0);
    assert.equal(manager.lastContactSyncStats, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('schedules reconnect after a disconnect and clears the timer on manual stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    let started = 0;
    manager.startAccount = async () => {
      started += 1;
    };

    manager.scheduleReconnect('acc_1');
    assert.equal(manager.reconnectTimers.size, 1);
    t.mock.timers.tick(60000);
    await Promise.resolve();
    assert.equal(started, 1);
    assert.equal(manager.reconnectTimers.size, 0);

    manager.scheduleReconnect('acc_1');
    assert.equal(manager.reconnectTimers.size, 1);
    await manager.stopAccount('acc_1');
    assert.equal(manager.reconnectTimers.size, 0);
    t.mock.timers.tick(60000);
    await Promise.resolve();
    assert.equal(started, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
