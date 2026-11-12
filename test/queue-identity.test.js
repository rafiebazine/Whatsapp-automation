const test = require('node:test');
const assert = require('node:assert/strict');
const { QueueManager } = require('../electron/queue');
const { accountIsAdminOfGroup } = require('../electron/identity');

function makeDb() {
  const group = {
    id: '120363000000000000@g.us',
    name: 'Group',
    adminIds: ['111@lid'],
    adminAccountIds: [],
    members: [
      {
        id: '111@lid',
        jid: '212600000001@s.whatsapp.net',
        lid: '111@lid',
        phoneNumber: '212600000001',
        isAdmin: true
      },
      { id: '222@lid', lid: '222@lid', phoneNumber: '', isAdmin: false },
      {
        id: '212600000002@s.whatsapp.net',
        jid: '212600000002@s.whatsapp.net',
        lid: '',
        phoneNumber: '212600000002',
        isAdmin: false
      }
    ]
  };
  return {
    data: {
      accounts: [
        {
          id: 'acc_1',
          alias: 'Admin',
          status: 'connected',
          phoneNumber: '212600000001',
          whatsappJid: '212600000001@s.whatsapp.net',
          whatsappLid: '111@lid',
          dailyActionCount: 0,
          dailyActionLimit: 20,
          needsRelink: false,
          batchPauseUntil: 0,
          pausedForDay: null
        }
      ],
      groups: [group],
      jobs: [],
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
    findGroup(id) {
      return this.data.groups.find((item) => item.id === id);
    },
    findJob(id) {
      return this.data.jobs.find((item) => item.id === id);
    },
    contactName() {
      return '';
    },
    todayKey() {
      return '2026-11-11';
    },
    addLog() {}
  };
}

function makeQueue(db) {
  const sessions = {
    isConnected: () => true,
    isAdminOf: (account, group) => accountIsAdminOfGroup(account, group),
    sendAction: async () => [],
    refreshGroup: async () => {}
  };
  return new QueueManager({ db, sessions });
}

test('recognizes a LID-only admin account', () => {
  const db = makeDb();
  const queue = makeQueue(db);
  const eligible = queue.getEligibleAccounts(db.data.groups[0], Date.now());
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].id, 'acc_1');
});

test('creates remove jobs for LID-only members', () => {
  const db = makeDb();
  const queue = makeQueue(db);
  const job = queue.createJob({
    type: 'remove',
    groupId: db.data.groups[0].id,
    targets: [{ jid: '222@lid', name: 'LID member' }]
  });
  assert.equal(job.targets.length, 1);
  assert.equal(job.targets[0].jid, '222@lid');
  assert.equal(job.targets[0].number, '222@lid');
  assert.equal(job.targets[0].status, 'pending');
});

test('does not queue LID-only members for add', () => {
  const db = makeDb();
  const queue = makeQueue(db);
  assert.throws(() => queue.createJob({
    type: 'add',
    groupId: db.data.groups[0].id,
    targets: [{ jid: '222@lid' }]
  }), /No new valid recipients/);
});

test('keeps legacy phone-number job creation working', () => {
  const db = makeDb();
  const queue = makeQueue(db);
  const job = queue.createJob({
    type: 'add',
    groupId: db.data.groups[0].id,
    numbers: ['+212600000003'],
    names: { '+212600000003': 'New member' }
  });
  assert.equal(job.targets[0].number, '+212600000003');
  assert.equal(job.targets[0].jid, '212600000003@s.whatsapp.net');
  assert.equal(job.targets[0].name, 'New member');
});

test('prevents duplicate pending LID targets', () => {
  const db = makeDb();
  const queue = makeQueue(db);
  queue.createJob({
    type: 'remove',
    groupId: db.data.groups[0].id,
    targets: [{ jid: '222@lid' }]
  });
  assert.throws(() => queue.createJob({
    type: 'remove',
    groupId: db.data.groups[0].id,
    targets: [{ jid: '222@lid' }]
  }), /None of these recipients/);
});

test('executes LID targets and normalizes string statuses', async () => {
  const db = makeDb();
  const queue = makeQueue(db);
  let sent = null;
  queue.sessions.sendAction = async (accountId, groupId, targets, action) => {
    sent = { accountId, groupId, targets, action };
    return [{ status: '200', jid: '222@lid' }];
  };
  const job = queue.createJob({
    type: 'remove',
    groupId: db.data.groups[0].id,
    targets: [{ jid: '222@lid' }]
  });

  await queue.execute(job, job.targets[0], db.data.accounts[0], db.data.groups[0]);

  assert.equal(sent.targets[0].jid, '222@lid');
  assert.equal(sent.action, 'remove');
  assert.equal(job.targets[0].status, 'success');
  assert.equal(job.status, 'completed');
});
