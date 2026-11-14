const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../electron/db');
const { SessionManager, shouldProcessHistorySync } = require('../electron/session-manager');

function makeManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-history-sync-test-'));
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

test('only processes recent, initial bootstrap, and push-name history sync types', () => {
  assert.equal(shouldProcessHistorySync({ syncType: 0 }), true);
  assert.equal(shouldProcessHistorySync({ syncType: 3 }), true);
  assert.equal(shouldProcessHistorySync({ syncType: 4 }), true);
  assert.equal(shouldProcessHistorySync({ syncType: 2 }), false);
  assert.equal(shouldProcessHistorySync({ syncType: 6 }), false);
  assert.equal(shouldProcessHistorySync(null), false);
});

test('ingests history contacts and chats into group member names', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    const lid = '2000000001@lid';
    const phoneNumber = '212600000001';
    const jid = `${phoneNumber}@s.whatsapp.net`;
    db.data.groups.push({
      id: 'group-1@g.us',
      name: 'Group One',
      members: [
        { id: lid, lid, phoneNumber: '', displayName: '' },
        { id: jid, jid, phoneNumber, displayName: '' }
      ],
      adminIds: [],
      adminAccountIds: []
    });

    const total = await manager.ingestHistory('acc_1', {
      contacts: [{ id: lid, lid, notify: 'Push Name' }],
      chats: [
        { id: jid, name: 'Saved Chat Name' },
        { id: '9999999999@g.us', name: 'Group Subject' }
      ]
    });

    assert.equal(total, 2);
    assert.equal(db.data.contacts.length, 2);
    assert.equal(db.contactName({ lid }), 'Push Name');
    assert.equal(db.contactName({ jid }), 'Saved Chat Name');
    assert.equal(db.data.groups[0].members[0].displayName, 'Push Name');
    assert.equal(db.data.groups[0].members[1].displayName, 'Saved Chat Name');
    assert.equal(db.findContact('9999999999@g.us'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chat names do not overwrite a higher-priority saved contact name', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    const phoneNumber = '212600000002';
    const jid = `${phoneNumber}@s.whatsapp.net`;
    db.upsertContactIdentity({ jid, phoneNumber }, 'Saved Name', 'acc_1', 'contact', 'whatsapp');

    await manager.ingestChats('acc_1', [{ id: jid, notify: 'Push Name' }]);
    assert.equal(db.findContact({ jid }).name, 'Saved Name');
    assert.equal(db.findContact({ jid }).nameSource, 'whatsapp');

    await manager.ingestChats('acc_1', [{ id: jid, name: 'Chat Name' }]);
    assert.equal(db.findContact({ jid }).name, 'Saved Name');
    assert.equal(db.findContact({ jid }).nameSource, 'whatsapp');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('links explicit LID and PN identities and propagates the merged name', async () => {
  const { db, dir, manager } = makeManager();
  try {
    addAccount(db, 'acc_1');
    const lid = '2000000003@lid';
    const phoneNumber = '212600000003';
    const jid = `${phoneNumber}@s.whatsapp.net`;
    db.upsertContactIdentity({ jid, phoneNumber }, 'Saved Name', 'acc_1', 'contact', 'whatsapp');
    db.upsertContactIdentity({ id: lid, lid }, 'Push Name', 'acc_1', 'group', 'participant');
    db.data.groups.push({
      id: 'group-1@g.us',
      name: 'Group One',
      members: [{ id: lid, lid, phoneNumber: '', displayName: '' }],
      adminIds: [],
      adminAccountIds: []
    });

    assert.equal(db.data.contacts.length, 2);
    const result = await manager.linkContactIdentities('acc_1', { lid, jid });
    assert.equal(result, 1);
    assert.equal(db.data.contacts.length, 1);
    assert.equal(db.findContact({ lid }), db.findContact({ jid }));
    assert.equal(db.contactName({ lid }), 'Saved Name');
    assert.equal(db.contactName({ jid }), 'Saved Name');
    assert.equal(db.data.groups[0].members[0].displayName, 'Saved Name');
    assert.deepEqual(db.data.contacts[0].sourceTypes.sort(), ['contact', 'group', 'mapping']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});