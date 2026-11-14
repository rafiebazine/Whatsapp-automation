const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../electron/db');
const { importContacts } = require('../electron/contact-import');

function makeDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-contact-import-'));
  const filePath = path.join(dir, 'data.json');
  const db = new Database(filePath);
  db.load();
  return { db, dir, filePath };
}

test('imports canonical Algerian number variants as one local contact', () => {
  const { db, dir } = makeDatabase();
  try {
    const variants = ['0551234567', '213551234567', '+213551234567', '00213551234567'];
    const result = importContacts(db, variants.map((number, index) => ({
      number,
      name: index === 0 ? 'Amina' : ''
    })));

    assert.equal(result.imported, 4);
    assert.equal(result.named, 1);
    assert.equal(result.unnamed, 3);
    assert.equal(result.skipped, 0);
    assert.equal(db.data.contacts.length, 1);

    const contact = db.findContact({ phoneNumber: '0551234567' });
    assert.equal(contact.id, '213551234567@s.whatsapp.net');
    assert.equal(contact.phoneNumber, '213551234567');
    assert.equal(contact.name, 'Amina');
    assert.equal(contact.localName, 'Amina');
    assert.equal(contact.nameSource, 'local');
    assert.deepEqual(contact.sourceTypes, ['import']);
    assert.deepEqual(contact.sourceAccounts, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('imported local names survive later WhatsApp and participant names', () => {
  const { db, dir } = makeDatabase();
  try {
    importContacts(db, [{ number: '0551234567', jid: '213551234567@s.whatsapp.net', name: 'Local Name' }]);
    db.upsertContactIdentity(
      { id: '111@lid', jid: '213551234567@s.whatsapp.net', lid: '111@lid', phoneNumber: '213551234567' },
      'WhatsApp Name',
      'acc_1',
      'contact',
      'whatsapp'
    );
    db.upsertContactIdentity(
      { id: '111@lid', jid: '213551234567@s.whatsapp.net', lid: '111@lid', phoneNumber: '213551234567' },
      'Participant Name',
      'acc_1',
      'group',
      'participant'
    );

    const contact = db.findContact({ lid: '111@lid' });
    assert.equal(contact.name, 'Local Name');
    assert.equal(contact.localName, 'Local Name');
    assert.equal(contact.nameSource, 'local');
    assert.deepEqual(contact.sourceTypes, ['import', 'contact', 'group']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unnamed imports never overwrite an existing valid name', () => {
  const { db, dir } = makeDatabase();
  try {
    db.upsertContactIdentity(
      { id: '213551234567@s.whatsapp.net', jid: '213551234567@s.whatsapp.net', phoneNumber: '213551234567' },
      'WhatsApp Name',
      'acc_1',
      'contact',
      'whatsapp'
    );
    importContacts(db, [{ number: '0551234567', name: '' }]);

    const contact = db.findContact({ phoneNumber: '0551234567' });
    assert.equal(contact.name, 'WhatsApp Name');
    assert.equal(contact.localName, '');
    assert.equal(contact.nameSource, 'whatsapp');
    assert.deepEqual(contact.sourceTypes, ['contact', 'import']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps imported LID contacts separate from the same numeric phone identity', () => {
  const { db, dir } = makeDatabase();
  try {
    importContacts(db, [
      { number: '212600000002@lid', jid: '212600000002@lid', name: 'LID Member' },
      { number: '+212600000002', jid: '212600000002@s.whatsapp.net', name: 'Phone Member' }
    ]);

    const lid = db.findContact({ lid: '212600000002@lid' });
    const phone = db.findContact({ phoneNumber: '212600000002' });
    assert.equal(db.data.contacts.length, 2);
    assert.notEqual(lid, phone);
    assert.equal(lid.lid, '212600000002@lid');
    assert.equal(lid.jid, '');
    assert.equal(lid.phoneNumber, '');
    assert.equal(lid.name, 'LID Member');
    assert.equal(phone.jid, '212600000002@s.whatsapp.net');
    assert.equal(phone.lid, '');
    assert.equal(phone.name, 'Phone Member');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skips malformed rows without creating contacts', () => {
  const { db, dir } = makeDatabase();
  try {
    const result = importContacts(db, [null, {}, { number: 'bad' }, { number: 'foo@bar' }]);
    assert.equal(result.imported, 0);
    assert.equal(result.skipped, 4);
    assert.equal(db.data.contacts.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshes cached group member and job target display names', () => {
  const { db, dir } = makeDatabase();
  try {
    db.data.groups.push({
      id: '120363000000000000@g.us',
      name: 'Group',
      members: [{
        id: '213551234567@s.whatsapp.net',
        jid: '213551234567@s.whatsapp.net',
        phoneNumber: '213551234567',
        displayName: ''
      }]
    });
    db.data.jobs.push({
      id: 'job_1',
      groupId: '120363000000000000@g.us',
      targets: [{
        number: '+213551234567',
        jid: '213551234567@s.whatsapp.net',
        displayName: ''
      }]
    });

    const result = importContacts(db, [{ number: '0551234567', name: 'Amina' }]);
    const changed = db.refreshCachedDisplayNames(result.contacts);

    assert.equal(changed, 2);
    assert.equal(db.data.groups[0].members[0].displayName, 'Amina');
    assert.equal(db.data.jobs[0].targets[0].displayName, 'Amina');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('imported contacts remain available after reloading from disk', () => {
  const { db, dir, filePath } = makeDatabase();
  try {
    importContacts(db, [{ number: '0551234567', name: 'Persisted Import' }]);
    db.save();

    const reloaded = new Database(filePath);
    reloaded.load();
    const contact = reloaded.findContact({ phoneNumber: '0551234567' });
    assert.equal(contact.name, 'Persisted Import');
    assert.equal(contact.localName, 'Persisted Import');
    assert.deepEqual(contact.sourceTypes, ['import']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
