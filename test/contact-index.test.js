const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../electron/db');
const { SessionManager } = require('../electron/session-manager');

function makeDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-contact-index-test-'));
  const filePath = path.join(dir, 'data.json');
  const db = new Database(filePath);
  db.load();
  return { db, dir, filePath };
}

test('indexes PN, LID, and phone identities without merging them', () => {
  const { db, dir } = makeDatabase();
  try {
    const phoneContact = db.upsertContactIdentity(
      { id: '212600000001@s.whatsapp.net', jid: '212600000001@s.whatsapp.net', phoneNumber: '212600000001' },
      'Phone contact',
      'acc_1',
      'contact',
      'whatsapp'
    );
    const lidContact = db.upsertContactIdentity(
      { id: '212600000001@lid', lid: '212600000001@lid', phoneNumber: '' },
      'LID contact',
      'acc_1',
      'group',
      'participant'
    );

    assert.equal(db.findContact({ jid: '212600000001@s.whatsapp.net' }), phoneContact);
    assert.equal(db.findContact({ phoneNumber: '212600000001' }), phoneContact);
    assert.equal(db.findContact({ lid: '212600000001@lid' }), lidContact);
    assert.notEqual(phoneContact, lidContact);
    assert.equal(db.data.contacts.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preserves first-match precedence when multiple indexed keys match', () => {
  const { db, dir } = makeDatabase();
  try {
    db.data.contacts = [
      { id: 'first', jid: '111@s.whatsapp.net', lid: '', phoneNumber: '111' },
      { id: 'second', jid: '', lid: '222@lid', phoneNumber: '' }
    ];
    db.rebuildContactIndex();

    const match = db.findContact({ lid: '222@lid', jid: '111@s.whatsapp.net' });
    assert.equal(match.id, 'first');
    assert.equal(db.contactName({ lid: '222@lid' }), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('indexes identity enrichments immediately without rebuilding', () => {
  const { db, dir } = makeDatabase();
  try {
    const contact = db.upsertContactIdentity(
      { id: '333@lid', lid: '333@lid', phoneNumber: '' },
      'LID only',
      'acc_1',
      'group',
      'participant'
    );
    const rebuilds = db.getContactIndexStats().rebuilds;

    const enriched = db.upsertContactIdentity(
      {
        id: '333@lid',
        lid: '333@lid',
        jid: '212600000333@s.whatsapp.net',
        phoneNumber: '212600000333'
      },
      'Enriched',
      'acc_1',
      'contact',
      'whatsapp'
    );

    assert.equal(enriched, contact);
    assert.equal(db.findContact({ jid: '212600000333@s.whatsapp.net' }), contact);
    assert.equal(db.findContact({ phoneNumber: '212600000333' }), contact);
    assert.equal(db.getContactIndexStats().rebuilds, rebuilds);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rebuilds the index when a database is loaded from disk', () => {
  const { db, dir, filePath } = makeDatabase();
  try {
    db.upsertContactIdentity(
      { id: '444@lid', lid: '444@lid', phoneNumber: '' },
      'Persisted contact',
      'acc_1',
      'group',
      'participant'
    );
    db.save();

    const reloaded = new Database(filePath);
    reloaded.load();
    const contact = reloaded.findContact({ lid: '444@lid' });
    assert.equal(contact.id, '444@lid');
    assert.equal(contact.name, 'Persisted contact');
    assert.equal(reloaded.getContactIndexStats().ready, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps contact references and index entries valid when an account is removed', async () => {
  const { db, dir } = makeDatabase();
  try {
    const identity = { id: '555@lid', lid: '555@lid', phoneNumber: '' };
    db.data.accounts.push({ id: 'acc_1', authFolder: 'acc_1' });
    const contact = db.upsertContactIdentity(identity, 'Shared contact', 'acc_1', 'group', 'participant');
    db.upsertContactIdentity(identity, 'Shared contact', 'acc_2', 'group', 'participant');

    const manager = new SessionManager({ db, sessionsRoot: path.join(dir, 'sessions') });
    await manager.removeAccount('acc_1');

    assert.equal(db.data.contacts[0], contact);
    assert.deepEqual(contact.sourceAccounts, ['acc_2']);
    assert.equal(db.findContact(identity), contact);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('indexed lookups do not scan the contacts collection', () => {
  const { db, dir } = makeDatabase();
  try {
    for (let index = 0; index < 500; index += 1) {
      db.upsertContactIdentity(
        { id: `${700000000 + index}@lid`, lid: `${700000000 + index}@lid`, phoneNumber: '' },
        `Contact ${index}`,
        'acc_1',
        'group',
        'participant'
      );
    }

    const contacts = db.data.contacts;
    contacts.find = () => {
      throw new Error('contacts collection was scanned');
    };
    try {
      for (let index = 0; index < 500; index += 1) {
        assert.ok(db.findContact({ lid: `${700000000 + index}@lid` }));
      }
    } finally {
      delete contacts.find;
    }

    assert.equal(db.getContactIndexStats().contactsScanned, 0);
    assert.equal(db.getContactIndexStats().hits, 500);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('group refresh resolves contact names through the index without scanning contacts', async () => {
  const { db, dir } = makeDatabase();
  try {
    db.data.accounts.push({
      id: 'acc_1',
      alias: 'Admin',
      authFolder: 'acc_1',
      phoneNumber: '212600000001',
      whatsappId: '111@lid',
      whatsappJid: '212600000001@s.whatsapp.net',
      whatsappLid: '111@lid',
      status: 'connected'
    });
    const group = {
      id: '120363000000000000@g.us',
      name: 'Group',
      adminIds: ['111@lid'],
      adminAccountIds: ['acc_1'],
      members: []
    };
    db.data.groups.push(group);
    for (let index = 0; index < 300; index += 1) {
      db.upsertContactIdentity(
        { id: `${800000000 + index}@lid`, lid: `${800000000 + index}@lid`, phoneNumber: '' },
        `Indexed ${index}`,
        'acc_1',
        'group',
        'participant'
      );
    }

    const manager = new SessionManager({ db, sessionsRoot: path.join(dir, 'sessions') });
    manager.sockets.set('acc_1', {
      connected: true,
      sock: {
        groupMetadata: async () => ({
          id: group.id,
          subject: 'Group',
          addressingMode: 'lid',
          participants: [
            { id: '111@lid', lid: '111@lid', name: 'Admin', admin: 'admin' },
            { id: '800000123@lid', lid: '800000123@lid', name: 'Indexed 123' }
          ]
        })
      }
    });

    const contacts = db.data.contacts;
    contacts.find = () => {
      throw new Error('contacts collection was scanned');
    };
    try {
      await manager.refreshManagedGroups('acc_1');
    } finally {
      delete contacts.find;
    }

    assert.equal(group.members.length, 2);
    const member = group.members.find((item) => item.id === '800000123@lid');
    assert.equal(member.displayName, 'Indexed 123');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
