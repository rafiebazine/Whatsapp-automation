const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../electron/db');
const { SessionManager } = require('../electron/session-manager');
const { sanitizeContactName } = require('../src/shared/identity');

function makeDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-contact-source-'));
  const filePath = path.join(dir, 'data.json');
  const db = new Database(filePath);
  db.load();
  return { db, dir, filePath };
}

function group(id = '120363000000000000@g.us') {
  return {
    id,
    name: 'Group',
    adminIds: ['111@lid'],
    adminAccountIds: ['acc_1'],
    members: []
  };
}

test('database contacts remain the canonical name source over participant names', () => {
  const { db, dir } = makeDatabase();
  try {
    const identity = {
      id: '111@lid',
      jid: '212600000001@s.whatsapp.net',
      lid: '111@lid',
      phoneNumber: '212600000001'
    };
    db.upsertContactIdentity(identity, 'Canonical Name', 'acc_1', 'contact', 'whatsapp');
    const target = group();
    db.data.groups.push(target);

    const manager = new SessionManager({ db, sessionsRoot: path.join(dir, 'sessions') });
    manager.applyMetadataToGroup(target, {
      id: target.id,
      subject: 'Group',
      participants: [
        { id: '111@lid', jid: '212600000001@s.whatsapp.net', lid: '111@lid', name: 'Participant Name', admin: 'admin' }
      ]
    }, db.data.accounts[0] || { id: 'acc_1' }, true);

    assert.equal(target.members[0].displayName, 'Canonical Name');
    assert.equal(db.contactName(identity), 'Canonical Name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('empty names never overwrite an existing valid name', () => {
  const { db, dir } = makeDatabase();
  try {
    const identity = { id: '212600000002@s.whatsapp.net', jid: '212600000002@s.whatsapp.net', phoneNumber: '212600000002' };
    db.upsertContactIdentity(identity, 'Valid Name', 'acc_1', 'contact', 'whatsapp');
    db.upsertContactIdentity(identity, '', 'acc_2', 'group', 'participant');
    db.upsertContactIdentity(identity, 'Unknown contact', 'acc_2', 'group', 'participant');
    assert.equal(db.contactName(identity), 'Valid Name');
    assert.equal(db.data.contacts.length, 1);
    assert.equal(sanitizeContactName('Unknown contact'), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('omitted contacts are never deleted by a later sync', async () => {
  const { db, dir } = makeDatabase();
  try {
    const manager = new SessionManager({ db, sessionsRoot: path.join(dir, 'sessions') });
    db.upsertContactIdentity(
      { id: '212600000003@s.whatsapp.net', jid: '212600000003@s.whatsapp.net', phoneNumber: '212600000003' },
      'Existing Contact',
      'acc_1',
      'contact',
      'whatsapp'
    );
    await manager.processContactIngest('acc_1', [
      { id: '212600000004@s.whatsapp.net', jid: '212600000004@s.whatsapp.net', name: 'New Contact' }
    ]);
    assert.equal(db.data.contacts.length, 2);
    assert.equal(db.contactName({ phoneNumber: '212600000003' }), 'Existing Contact');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('does not merge PN and LID identities based on matching names', () => {
  const { db, dir } = makeDatabase();
  try {
    db.upsertContactIdentity(
      { id: '212600000005@s.whatsapp.net', jid: '212600000005@s.whatsapp.net', phoneNumber: '212600000005' },
      'Same Name',
      'acc_1',
      'contact',
      'whatsapp'
    );
    db.upsertContactIdentity(
      { id: '555@lid', lid: '555@lid', phoneNumber: '' },
      'Same Name',
      'acc_1',
      'group',
      'participant'
    );
    assert.equal(db.data.contacts.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit PN and LID mapping is persisted on one contact', () => {
  const { db, dir } = makeDatabase();
  try {
    const contact = db.upsertContactIdentity(
      {
        id: '666@lid',
        jid: '212600000006@s.whatsapp.net',
        lid: '666@lid',
        phoneNumber: '212600000006'
      },
      'Mapped Contact',
      'acc_1',
      'contact',
      'whatsapp'
    );
    assert.equal(contact.jid, '212600000006@s.whatsapp.net');
    assert.equal(contact.lid, '666@lid');
    assert.equal(db.findContact({ jid: '212600000006@s.whatsapp.net' }), contact);
    assert.equal(db.findContact({ lid: '666@lid' }), contact);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loading the database hydrates cached group and job display names', () => {
  const { db, dir, filePath } = makeDatabase();
  try {
    const contact = db.upsertContactIdentity(
      { id: '212600000007@s.whatsapp.net', jid: '212600000007@s.whatsapp.net', phoneNumber: '212600000007' },
      'Canonical Seven',
      'acc_1',
      'contact',
      'whatsapp'
    );
    const target = group();
    target.members.push({
      id: contact.id,
      jid: contact.jid,
      phoneNumber: contact.phoneNumber,
      displayName: 'Stale Name'
    });
    db.data.groups.push(target);
    db.data.jobs.push({
      id: 'job_1',
      status: 'queued',
      targets: [{ jid: contact.jid, displayName: 'Stale Name', status: 'pending' }]
    });
    db.save();

    const reloaded = new Database(filePath);
    reloaded.load();
    assert.equal(reloaded.data.groups[0].members[0].displayName, 'Canonical Seven');
    assert.equal(reloaded.data.jobs[0].targets[0].displayName, 'Canonical Seven');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('enriches returned members from the central contact index without mutating storage', () => {
  const { db, dir } = makeDatabase();
  try {
    const contact = db.upsertContactIdentity(
      { id: '777@lid', lid: '777@lid', phoneNumber: '' },
      'Resolved LID Name',
      'acc_1',
      'contact',
      'whatsapp'
    );
    const member = { id: '777@lid', lid: '777@lid', phoneNumber: '', displayName: '' };
    const enriched = db.enrichMember(member);
    assert.equal(enriched.displayName, 'Resolved LID Name');
    assert.equal(enriched.id, contact.id);
    assert.equal(member.displayName, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('contact ingestion updates matching members in every group', async () => {
  const { db, dir } = makeDatabase();
  try {
    const first = group('120363000000000010@g.us');
    const second = group('120363000000000011@g.us');
    first.members.push({ id: '778@lid', lid: '778@lid', phoneNumber: '', displayName: '' });
    second.members.push({ id: '778@lid', lid: '778@lid', phoneNumber: '', displayName: 'Old Name' });
    db.data.groups.push(first, second);

    const manager = new SessionManager({ db, sessionsRoot: path.join(dir, 'sessions') });
    let groupsUpdates = 0;
    manager.on('groups:update', () => { groupsUpdates += 1; });

    await manager.processContactIngest('acc_1', [
      { id: '778@lid', lid: '778@lid', name: 'Updated LID Name' }
    ]);

    assert.equal(first.members[0].displayName, 'Updated LID Name');
    assert.equal(second.members[0].displayName, 'Updated LID Name');
    assert.ok(groupsUpdates > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('empty contact names preserve cached member names', async () => {
  const { db, dir } = makeDatabase();
  try {
    const target = group('120363000000000012@g.us');
    target.members.push({ id: '779@lid', lid: '779@lid', phoneNumber: '', displayName: 'Cached Member Name' });
    db.data.groups.push(target);

    const manager = new SessionManager({ db, sessionsRoot: path.join(dir, 'sessions') });
    await manager.processContactIngest('acc_1', [
      { id: '779@lid', lid: '779@lid', name: '' }
    ]);

    assert.equal(target.members[0].displayName, 'Cached Member Name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolves PN and LID members separately without name-based merging', () => {
  const { db, dir } = makeDatabase();
  try {
    db.upsertContactIdentity(
      { id: '212600000010@s.whatsapp.net', jid: '212600000010@s.whatsapp.net', phoneNumber: '212600000010' },
      'PN Name',
      'acc_1',
      'contact',
      'whatsapp'
    );
    db.upsertContactIdentity(
      { id: '780@lid', lid: '780@lid', phoneNumber: '' },
      'LID Name',
      'acc_1',
      'contact',
      'whatsapp'
    );
    const pnMember = { id: '212600000010@s.whatsapp.net', jid: '212600000010@s.whatsapp.net', phoneNumber: '212600000010' };
    const lidMember = { id: '780@lid', lid: '780@lid', phoneNumber: '' };
    assert.equal(db.enrichMember(pnMember).displayName, 'PN Name');
    assert.equal(db.enrichMember(lidMember).displayName, 'LID Name');
    assert.equal(db.data.contacts.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('full contact sync propagates names without a group re-add', async () => {
  const { db, dir } = makeDatabase();
  try {
    const target = group('120363000000000013@g.us');
    target.members.push({ id: '781@lid', lid: '781@lid', phoneNumber: '', displayName: '' });
    db.data.groups.push(target);

    const manager = new SessionManager({ db, sessionsRoot: path.join(dir, 'sessions') });
    manager.sockets.set('acc_1', {
      connected: true,
      sock: {
        groupFetchAllParticipating: async () => ({
          [target.id]: {
            id: target.id,
            subject: target.name,
            participants: [{ id: '781@lid', lid: '781@lid', name: 'Synced LID Name' }]
          }
        })
      }
    });
    let groupsUpdates = 0;
    manager.on('groups:update', () => { groupsUpdates += 1; });

    await manager.syncContacts('acc_1');

    assert.equal(target.members[0].displayName, 'Synced LID Name');
    assert.ok(groupsUpdates > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
