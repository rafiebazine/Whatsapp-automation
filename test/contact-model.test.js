const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../electron/db');

function makeDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-contact-test-'));
  const db = new Database(path.join(dir, 'data.json'));
  db.load();
  return { db, dir };
}

test('merges identities and upgrades names by source priority', () => {
  const { db, dir } = makeDatabase();
  try {
    const identity = {
      id: '111@lid',
      jid: '212600000001@s.whatsapp.net',
      lid: '111@lid',
      phoneNumber: '212600000001'
    };

    const first = db.upsertContactIdentity(identity, 'Participant', 'acc_1', 'group', 'participant');
    assert.equal(first.name, 'Participant');
    assert.equal(first.nameSource, 'participant');
    assert.deepEqual(first.sourceTypes, ['group']);

    const local = db.upsertContactIdentity(identity, 'Local Name', 'acc_1', 'manual', 'local');
    assert.equal(local.localName, 'Local Name');
    assert.equal(local.name, 'Local Name');
    assert.equal(local.nameSource, 'local');

    db.upsertContactIdentity(identity, 'Other Participant', 'acc_2', 'group', 'participant');
    assert.equal(local.name, 'Local Name');
    assert.equal(local.nameSource, 'local');
    assert.deepEqual(local.sourceAccounts, ['acc_1', 'acc_2']);
    assert.deepEqual(local.sourceTypes, ['group', 'manual']);
    assert.equal(db.contactName(identity), 'Local Name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps LID-only contacts separate from similar phone identities', () => {
  const { db, dir } = makeDatabase();
  try {
    db.upsertContactIdentity(
      { id: '212600000002@s.whatsapp.net', jid: '212600000002@s.whatsapp.net', phoneNumber: '212600000002' },
      'Phone contact',
      'acc_1',
      'contact',
      'whatsapp'
    );
    db.upsertContactIdentity(
      { id: '212600000002@lid', lid: '212600000002@lid', phoneNumber: '' },
      'LID contact',
      'acc_1',
      'group',
      'participant'
    );

    assert.equal(db.data.contacts.length, 2);
    const lid = db.findContact({ lid: '212600000002@lid' });
    assert.equal(lid.id, '212600000002@lid');
    assert.equal(lid.phoneNumber, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
