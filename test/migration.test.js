const test = require('node:test');
const assert = require('node:assert/strict');
const { migrateData } = require('../electron/db');

function legacyData() {
  return {
    version: 1,
    accounts: [
      { id: 'acc_1', alias: 'Admin', phoneNumber: '212612345678' },
      { id: 'acc_2', alias: 'LID only', whatsappId: '222@lid' }
    ],
    groups: [
      {
        id: '120363000000000000@g.us',
        name: 'Legacy group',
        adminIds: ['212612345678'],
        adminAccountIds: ['acc_1'],
        members: [
          { phoneNumber: '212612345678', displayName: 'Admin' },
          { phoneNumber: '212699999999', displayName: 'Member' }
        ]
      },
      {
        id: '120363000000000001@g.us',
        name: 'LID group',
        adminIds: ['111@lid'],
        adminAccountIds: [],
        members: [
          { id: '111@lid', jid: '212600000001@s.whatsapp.net', lid: '111@lid', displayName: 'LID admin' },
          { id: '222@lid', lid: '222@lid', displayName: 'LID member' }
        ]
      }
    ],
    contacts: [
      { phoneNumber: '212612345678', name: 'Admin', sourceAccounts: ['acc_1'] },
      { id: '222@lid', name: 'LID contact', sourceAccounts: ['acc_1'] }
    ],
    jobs: [
      {
        id: 'job_1',
        status: 'queued',
        targets: [
          { number: '+212699999999', status: 'pending' },
          { number: '222@lid', status: 'running' }
        ]
      }
    ]
  };
}

test('migrates legacy phone data without losing LID members', () => {
  const data = migrateData(legacyData());
  assert.equal(data.version, 3);

  const legacyGroup = data.groups[0];
  assert.deepEqual(legacyGroup.adminIds, ['212612345678@s.whatsapp.net']);
  assert.equal(legacyGroup.members.length, 2);
  assert.equal(legacyGroup.members[0].id, '212612345678@s.whatsapp.net');
  assert.equal(legacyGroup.members[0].isAdmin, true);

  const lidGroup = data.groups[1];
  assert.deepEqual(lidGroup.adminIds, ['111@lid']);
  assert.equal(lidGroup.members.length, 2);
  assert.equal(lidGroup.members[0].phoneNumber, '212600000001');
  assert.equal(lidGroup.members[1].phoneNumber, '');
  assert.equal(lidGroup.members[1].id, '222@lid');

  assert.equal(data.accounts[0].whatsappJid, '212612345678@s.whatsapp.net');
  assert.equal(data.accounts[1].whatsappLid, '222@lid');
  assert.equal(data.accounts[1].phoneNumber, '');

  assert.equal(data.contacts.length, 2);
  assert.equal(data.contacts[1].id, '222@lid');
  assert.deepEqual(data.contacts[0].sourceTypes, ['group']);
  assert.equal(data.contacts[0].nameSource, 'whatsapp');

  assert.equal(data.jobs[0].targets[0].status, 'pending');
  assert.equal(data.jobs[0].targets[0].phoneNumber, '212699999999');
  assert.equal(data.jobs[0].targets[0].number, '212699999999');
  assert.equal(data.jobs[0].targets[0].displayName, '+212699999999');
  assert.equal(data.jobs[0].targets[1].status, 'running');
  assert.equal(data.jobs[0].targets[1].jid, '222@lid');
  assert.equal(data.jobs[0].targets[1].phoneNumber, '');
  assert.equal(data.jobs[0].targets[1].displayName, 'Unknown contact');
});

test('migration is idempotent', () => {
  const first = migrateData(legacyData());
  const second = migrateData(JSON.parse(JSON.stringify(first)));
  assert.deepEqual(second, first);
});

test('uses participant JIDs for admins without duplicating legacy phone admins', () => {
  const data = migrateData({
    version: 1,
    accounts: [],
    groups: [
      {
        id: '120363000000000002@g.us',
        name: 'Mixed admin group',
        adminIds: ['212600000001', '212600000099'],
        adminAccountIds: [],
        members: [
          {
            id: '111@lid',
            jid: '212600000001@s.whatsapp.net',
            lid: '111@lid',
            displayName: 'LID admin'
          }
        ]
      }
    ],
    contacts: [],
    jobs: []
  });

  assert.deepEqual(data.groups[0].adminIds, ['111@lid', '212600000099@s.whatsapp.net']);
  assert.equal(data.groups[0].members[0].isAdmin, true);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../electron/db');

function tempDatabase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'whatsapp-group-manager.json') };
}

test('creates a default database when the directory and file are missing', (t) => {
  const { dir, file } = tempDatabase(t);
  const database = new Database(file);
  const data = database.load();

  assert.equal(data.version, 3);
  assert.equal(data.auth, null);
  assert.deepEqual(data.accounts, []);
  assert.deepEqual(data.groups, []);
  assert.deepEqual(data.contacts, []);
  assert.deepEqual(data.jobs, []);
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.existsSync(file), true);
});

test('migrates a v2 database on load and persists version 3', (t) => {
  const { file } = tempDatabase(t);
  fs.writeFileSync(file, JSON.stringify({
    version: 2,
    accounts: [{ id: 'acc_1', alias: 'Admin', phoneNumber: '212612345678' }],
    groups: [{
      id: '120363000000000003@g.us',
      name: 'V2 group',
      adminIds: ['212612345678'],
      adminAccountIds: ['acc_1'],
      members: [{ phoneNumber: '212699999999', displayName: 'Member' }]
    }],
    contacts: [],
    jobs: []
  }), 'utf8');

  const database = new Database(file);
  const data = database.load();

  assert.equal(data.version, 3);
  assert.equal(data.accounts[0].whatsappJid, '212612345678@s.whatsapp.net');
  assert.deepEqual(data.groups[0].adminIds, ['212612345678@s.whatsapp.net']);

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.version, 3);
  assert.equal(saved.accounts[0].whatsappJid, '212612345678@s.whatsapp.net');
});

test('backs up an unreadable database instead of silently overwriting it', (t) => {
  const { dir, file } = tempDatabase(t);
  const original = '{ this is not valid json';
  fs.writeFileSync(file, original, 'utf8');
  const originalConsoleError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalConsoleError; });

  const database = new Database(file);
  const data = database.load();

  assert.equal(data.version, 3);
  assert.deepEqual(data.accounts, []);
  const backups = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original);
  assert.equal(fs.existsSync(file), true);
});
