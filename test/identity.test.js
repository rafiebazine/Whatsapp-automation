const test = require('node:test');
const assert = require('node:assert/strict');
const identity = require('../electron/identity');

test('extracts phone numbers only from phone-number JIDs', () => {
  assert.equal(identity.phoneFromJid('212612345678:4@s.whatsapp.net'), '212612345678');
  assert.equal(identity.phoneFromJid('212612345678@c.us'), '212612345678');
  assert.equal(identity.phoneFromJid('123456789012345@lid'), '');
  assert.equal(identity.phoneDigits('123456789012345@lid'), '');
  assert.equal(identity.phoneDigits('not-a-phone'), '');
});

test('normalizes device and agent suffixes without changing the server', () => {
  assert.equal(identity.normalizeJid('212612345678:12@s.whatsapp.net'), '212612345678@s.whatsapp.net');
  assert.equal(identity.normalizeJid('111:3@lid'), '111@lid');
  assert.equal(identity.normalizeJid('212612345678@c.us'), '212612345678@s.whatsapp.net');
  assert.equal(identity.normalizeJid('120363000000000000@g.us'), '120363000000000000@g.us');
});

test('keeps LID and PN identities separate even when their digits look alike', () => {
  assert.equal(
    identity.identityMatches('123456789012345@s.whatsapp.net', '123456789012345@lid'),
    false
  );
  assert.equal(identity.jidFromPhone('123456789012345@lid'), '');
});

test('builds a participant identity from Baileys Contact fields', () => {
  const identityValue = identity.participantIdentity({
    id: '111@lid',
    jid: '212612345678@s.whatsapp.net',
    lid: '111@lid',
    name: 'Admin'
  });
  assert.deepEqual(identityValue, {
    id: '111@lid',
    jid: '212612345678@s.whatsapp.net',
    lid: '111@lid',
    phoneNumber: '212612345678'
  });
});

test('matches accounts to LID admins and PN fallbacks', () => {
  const account = {
    id: 'acc_1',
    phoneNumber: '212612345678',
    whatsappJid: '212612345678@s.whatsapp.net',
    whatsappLid: '111@lid'
  };
  assert.equal(identity.accountIsAdminOfGroup(account, {
    adminIds: ['111@lid'],
    adminAccountIds: [],
    members: []
  }), true);

  assert.equal(identity.accountIsAdminOfGroup(account, {
    adminIds: [],
    adminAccountIds: [],
    members: [{ id: '111@lid', lid: '111@lid', isAdmin: true }]
  }), true);

  assert.equal(identity.accountIsAdminOfGroup(account, {
    adminIds: [],
    adminAccountIds: [],
    members: [{ id: '111@lid', jid: '212612345678@s.whatsapp.net', isAdmin: true }]
  }), true);

  assert.equal(identity.accountIsAdminOfGroup(account, {
    adminIds: ['999@lid'],
    adminAccountIds: [],
    members: []
  }), false);
});

test('prefers the LID for LID-addressed groups when available', () => {
  const account = {
    phoneNumber: '212612345678',
    whatsappJid: '212612345678@s.whatsapp.net',
    whatsappLid: '111@lid'
  };
  assert.equal(identity.preferredAccountJid(account, { addressingMode: 'lid' }), '111@lid');
  assert.equal(identity.preferredAccountJid(account, { addressingMode: 'pn' }), '212612345678@s.whatsapp.net');
  assert.equal(identity.normalizeAdminId('+212612345678'), '212612345678@s.whatsapp.net');
});

test('summarizes accounts stored with whatsapp identity fields', () => {
  const summary = identity.identitySummary({
    id: 'acc_1',
    phoneNumber: '',
    whatsappId: '111@lid',
    whatsappJid: '',
    whatsappLid: '111@lid'
  });
  assert.deepEqual(summary, {
    id: '111@lid',
    jid: '',
    lid: '111@lid',
    phoneNumber: ''
  });
});
