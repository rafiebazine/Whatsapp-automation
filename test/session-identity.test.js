const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionManager } = require('../electron/session-manager');

function makeDb() {
  const account = {
    id: 'acc_1',
    alias: 'Admin',
    authFolder: 'acc_1',
    phoneNumber: '212600000001',
    whatsappId: '111@lid',
    whatsappJid: '212600000001@s.whatsapp.net',
    whatsappLid: '111@lid',
    status: 'connected'
  };
  const group = {
    id: '120363000000000000@g.us',
    name: 'Group',
    adminIds: [],
    adminAccountIds: [],
    members: []
  };
  return {
    data: { accounts: [account], groups: [group], contacts: [], jobs: [], logs: [], settings: {} },
    save() {},
    findAccount(id) {
      return this.data.accounts.find((item) => item.id === id);
    },
    findGroup(id) {
      return this.data.groups.find((item) => item.id === id);
    },
    contactName() {
      return '';
    },
    upsertContactIdentity() {},
    addLog() {}
  };
}

function metadata() {
  return {
    id: '120363000000000000@g.us',
    subject: 'Group',
    addressingMode: 'lid',
    participants: [
      {
        id: '212600000002@s.whatsapp.net',
        jid: '212600000002@s.whatsapp.net',
        lid: '',
        name: 'Phone member'
      },
      {
        id: '111@lid',
        jid: '212600000001@s.whatsapp.net',
        lid: '111@lid',
        name: 'LID admin',
        admin: 'admin'
      },
      {
        id: '222@lid',
        jid: '',
        lid: '222@lid',
        name: 'LID member'
      }
    ]
  };
}

test('keeps phone-less LID participants and stores actual admin JIDs', () => {
  const db = makeDb();
  const manager = new SessionManager({ db, sessionsRoot: '/tmp/wgm-test-sessions' });
  const group = db.data.groups[0];
  const account = db.data.accounts[0];

  manager.applyMetadataToGroup(group, metadata(), account, true);

  assert.equal(group.members.length, 3);
  assert.deepEqual(group.adminIds, ['111@lid']);
  assert.deepEqual(group.adminAccountIds, ['acc_1']);
  const lidMember = group.members.find((member) => member.id === '222@lid');
  assert.equal(lidMember.phoneNumber, '');
  assert.equal(lidMember.displayName, 'LID member');
  assert.equal(group.hasError, false);
});

test('detects admin status through group members when adminIds use LID', () => {
  const db = makeDb();
  const manager = new SessionManager({ db, sessionsRoot: '/tmp/wgm-test-sessions' });
  const account = db.data.accounts[0];
  const group = {
    adminIds: [],
    adminAccountIds: [],
    members: [{ id: '111@lid', lid: '111@lid', isAdmin: true }]
  };
  assert.equal(manager.isAdminOf(account, group), true);
});

test('fetchGroups identifies the connected account by LID', async () => {
  const db = makeDb();
  const manager = new SessionManager({ db, sessionsRoot: '/tmp/wgm-test-sessions' });
  manager.sockets.set('acc_1', {
    connected: true,
    sock: {
      groupFetchAllParticipating: async () => ({
        '120363000000000000@g.us': metadata()
      })
    }
  });
  const groups = await manager.fetchGroups('acc_1');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].isAdmin, true);
});

test('sendAction preserves LID targets and converts phone targets to PN JIDs', async () => {
  const db = makeDb();
  const manager = new SessionManager({ db, sessionsRoot: '/tmp/wgm-test-sessions' });
  let captured = null;
  manager.sockets.set('acc_1', {
    connected: true,
    sock: {
      groupParticipantsUpdate: async (groupJid, jids, action) => {
        captured = { groupJid, jids, action };
        return jids.map((jid) => ({ status: '200', jid }));
      }
    }
  });

  const results = await manager.sendAction(
    'acc_1',
    '120363000000000000@g.us',
    [{ jid: '222@lid', number: '222@lid' }, { number: '+212600000003' }],
    'remove'
  );

  assert.deepEqual(captured.jids, ['222@lid', '212600000003@s.whatsapp.net']);
  assert.equal(results[0].status, 200);
  assert.equal(results[0].number, '222@lid');
  assert.equal(results[1].status, 200);
  assert.equal(results[1].number, '212600000003');
});

test('relink removes the old LID identity from groups', async () => {
  const db = makeDb();
  const account = db.data.accounts[0];
  account.phoneNumber = '';
  account.whatsappId = '111@lid';
  account.whatsappJid = '';
  account.whatsappLid = '111@lid';
  db.data.groups[0].adminIds = ['111@lid'];
  db.data.groups[0].adminAccountIds = ['acc_1'];
  db.data.groups[0].members = [{ id: '111@lid', lid: '111@lid', isAdmin: true }];

  const manager = new SessionManager({ db, sessionsRoot: '/tmp/wgm-test-sessions' });
  manager.stopAccount = async () => {};
  manager.startAccount = async () => {};

  await manager.relinkAccount('acc_1');

  assert.deepEqual(db.data.groups[0].adminIds, []);
  assert.deepEqual(db.data.groups[0].adminAccountIds, []);
  assert.deepEqual(db.data.groups[0].members, []);
  assert.equal(account.whatsappLid, '');
});
