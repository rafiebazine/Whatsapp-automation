const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionManager } = require('../electron/session-manager');
const { QueueManager } = require('../electron/queue');

const GROUP_ID = '120363000000000000@g.us';

function makeDb() {
  const accountOne = {
    id: 'acc_1',
    alias: 'One',
    authFolder: 'acc_1',
    phoneNumber: '213551234567',
    whatsappJid: '213551234567@s.whatsapp.net',
    whatsappLid: '111@lid',
    whatsappId: '111@lid',
    status: 'connected',
    adminAccess: {},
    dailyActionCount: 0,
    dailyActionLimit: 20,
    needsRelink: false,
    batchPauseUntil: 0,
    pausedForDay: null
  };
  const accountTwo = {
    id: 'acc_2',
    alias: 'Two',
    authFolder: 'acc_2',
    phoneNumber: '213661234567',
    whatsappJid: '213661234567@s.whatsapp.net',
    whatsappLid: '222@lid',
    whatsappId: '222@lid',
    status: 'connected',
    adminAccess: {},
    dailyActionCount: 0,
    dailyActionLimit: 20,
    needsRelink: false,
    batchPauseUntil: 0,
    pausedForDay: null
  };
  const group = {
    id: GROUP_ID,
    name: 'Group',
    adminIds: [],
    adminAccountIds: [],
    members: []
  };
  return {
    data: {
      accounts: [accountOne, accountTwo],
      groups: [group],
      contacts: [],
      jobs: [],
      logs: [],
      settings: {
        dailyCap: 20,
        minDelaySeconds: 1,
        maxDelaySeconds: 1,
        batchSize: 5,
        batchPauseMinSeconds: 1,
        batchPauseMaxSeconds: 1,
        failurePauseThreshold: 3
      }
    },
    save() {},
    findAccount(id) {
      return this.data.accounts.find((item) => item.id === id);
    },
    findGroup(id) {
      return this.data.groups.find((item) => item.id === id);
    },
    findJob(id) {
      return this.data.jobs.find((item) => item.id === id);
    },
    contactName() {
      return '';
    },
    upsertContactIdentity() {},
    todayKey() {
      return '2026-11-13';
    },
    addLog() {}
  };
}

function metadata(adminId = '111@lid') {
  return {
    id: GROUP_ID,
    subject: 'Group',
    addressingMode: 'lid',
    participants: [
      { id: '111@lid', lid: '111@lid', jid: '213551234567@s.whatsapp.net', name: 'One', admin: adminId === '111@lid' ? 'admin' : null },
      { id: '222@lid', lid: '222@lid', name: 'Two' },
      { id: '333@lid', lid: '333@lid', name: 'Member' }
    ]
  };
}

function makeManager(db, metadataFn = () => metadata()) {
  const manager = new SessionManager({ db, sessionsRoot: '/tmp/wgm-admin-test-sessions' });
  manager.sockets.set('acc_1', {
    connected: true,
    sock: {
      groupMetadata: async () => metadataFn(),
      groupFetchAllParticipating: async () => ({ [GROUP_ID]: metadataFn() }),
      groupParticipantsUpdate: async () => {
        throw new Error('groupParticipantsUpdate should not be called');
      }
    }
  });
  manager.sockets.set('acc_2', {
    connected: true,
    sock: {
      groupMetadata: async () => metadataFn(),
      groupFetchAllParticipating: async () => ({ [GROUP_ID]: metadataFn() })
    }
  });
  return manager;
}

test('records verified and demoted admin access per group', async () => {
  const db = makeDb();
  const manager = makeManager(db);
  await manager.refreshAdminAccess('acc_1');
  await manager.refreshAdminAccess('acc_2');

  assert.equal(manager.isVerifiedAdminOf(db.data.accounts[0], db.data.groups[0]), true);
  assert.equal(manager.isVerifiedAdminOf(db.data.accounts[1], db.data.groups[0]), false);
  assert.equal(db.data.accounts[1].adminAccess[GROUP_ID].status, 'not_admin');

  const managerDemoted = makeManager(db, () => metadata('222@lid'));
  await managerDemoted.refreshAdminAccess('acc_1');
  assert.equal(managerDemoted.isVerifiedAdminOf(db.data.accounts[0], db.data.groups[0]), false);
  assert.equal(db.data.accounts[0].adminAccess[GROUP_ID].status, 'not_admin');
});

test('queue only uses accounts verified as admins for the group', async () => {
  const db = makeDb();
  const manager = makeManager(db);
  await manager.refreshAdminAccess('acc_1');
  const queue = new QueueManager({ db, sessions: manager });

  const eligible = queue.getEligibleAccounts(db.data.groups[0], Date.now());
  assert.deepEqual(eligible.map((account) => account.id), ['acc_1']);

  db.data.accounts[0].adminAccess[GROUP_ID] = { status: 'not_admin', checkedAt: new Date().toISOString() };
  assert.equal(queue.getEligibleAccounts(db.data.groups[0], Date.now()).length, 0);
});

test('fresh metadata demotion blocks the account before WhatsApp is called', async () => {
  const db = makeDb();
  let demoted = false;
  const manager = makeManager(db, () => (demoted ? metadata('222@lid') : metadata()));
  await manager.refreshAdminAccess('acc_1');
  demoted = true;

  let called = false;
  manager.sockets.get('acc_1').sock.groupParticipantsUpdate = async () => {
    called = true;
    return [{ status: '200', jid: '333@lid' }];
  };

  await assert.rejects(
    manager.sendAction('acc_1', GROUP_ID, [{ jid: '333@lid' }], 'remove'),
    (error) => error.code === 'admin_unverified'
  );
  assert.equal(called, false);
  assert.equal(db.data.accounts[0].adminAccess[GROUP_ID].status, 'not_admin');
});

test('rejects removal of a linked admin account by LID', async () => {
  const db = makeDb();
  const manager = makeManager(db);
  await manager.refreshAdminAccess('acc_1');

  let called = false;
  manager.sockets.get('acc_1').sock.groupParticipantsUpdate = async () => {
    called = true;
    return [{ status: '200', jid: '222@lid' }];
  };

  await assert.rejects(
    manager.sendAction('acc_1', GROUP_ID, [{ jid: '222@lid' }], 'remove'),
    (error) => error.code === 'protected_admin_target'
  );
  assert.equal(called, false);
});

test('an account blocked in one group remains eligible in another group', async () => {
  const db = makeDb();
  const otherId = '120363000000000001@g.us';
  db.data.groups.push({
    id: otherId,
    name: 'Other',
    adminIds: [],
    adminAccountIds: [],
    members: []
  });
  const manager = makeManager(db, () => metadata('111@lid'));
  manager.sockets.get('acc_1').sock.groupFetchAllParticipating = async () => ({
    [GROUP_ID]: metadata('222@lid'),
    [otherId]: metadata('111@lid')
  });
  await manager.refreshAdminAccess('acc_1');

  assert.equal(manager.isVerifiedAdminOf(db.data.accounts[0], db.data.groups[0]), false);
  assert.equal(manager.isVerifiedAdminOf(db.data.accounts[0], db.data.groups[1]), true);
});
