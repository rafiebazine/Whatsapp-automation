const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePhone,
  formatPhone,
  sanitizeContactName,
  getContactDisplayName,
  getMemberKey,
  hasActiveJobsForGroup,
  mergeContactRecords
} = require('../src/shared/identity');

test('normalizes and formats genuine phone numbers only', () => {
  assert.equal(normalizePhone('+212 612-345-678'), '+212612345678');
  assert.equal(normalizePhone('00212612345678'), '+212612345678');
  assert.equal(normalizePhone('212612345678'), '+212612345678');
  assert.equal(formatPhone('212612345678'), '+212612345678');
  assert.equal(formatPhone('222@lid'), '');
  assert.equal(formatPhone('123'), '');
  assert.equal(normalizePhone('not a phone'), '');
});

test('rejects phone-like and identity values as names', () => {
  assert.equal(sanitizeContactName('Amina'), 'Amina');
  assert.equal(sanitizeContactName('  Amina  '), 'Amina');
  assert.equal(sanitizeContactName('+212612345678'), '');
  assert.equal(sanitizeContactName('212612345678'), '');
  assert.equal(sanitizeContactName('222@lid'), '');
  assert.equal(sanitizeContactName('212600000001@s.whatsapp.net'), '');
  assert.equal(sanitizeContactName(''), '');
});

test('resolves names with local and WhatsApp priorities', () => {
  assert.equal(getContactDisplayName({ localName: 'Local', name: 'WhatsApp' }), 'Local');
  assert.equal(getContactDisplayName({ name: 'WhatsApp', notify: 'Notify' }), 'WhatsApp');
  assert.equal(getContactDisplayName({ notify: 'Notify' }), 'Notify');
  assert.equal(getContactDisplayName({ name: '212612345678' }), 'Unknown contact');
  assert.equal(getContactDisplayName({}, 'Fallback'), 'Fallback');
});

test('builds stable member keys without inventing phone numbers', () => {
  assert.equal(getMemberKey({ id: '222@lid', lid: '222@lid', phoneNumber: '' }), '222@lid');
  assert.equal(getMemberKey({ jid: '212600000001@s.whatsapp.net', phoneNumber: '212600000001' }), '212600000001@s.whatsapp.net');
  assert.equal(getMemberKey('212600000002'), '212600000002@s.whatsapp.net');
  assert.equal(getMemberKey('222@lid'), '222@lid');
});

test('derives active group jobs from job state', () => {
  const jobs = [
    { groupId: 'g1', status: 'queued' },
    { groupId: 'g2', status: 'completed' },
    { groupId: 'g2', status: 'running' }
  ];
  assert.equal(hasActiveJobsForGroup(jobs, 'g1'), true);
  assert.equal(hasActiveJobsForGroup(jobs, 'g2'), true);
  assert.equal(hasActiveJobsForGroup(jobs, 'g3'), false);
});

test('merges contact records without losing sources', () => {
  const target = {
    id: '212600000001@s.whatsapp.net',
    sourceAccounts: ['acc_1'],
    sourceTypes: ['group']
  };
  mergeContactRecords(target, {
    localName: 'Local name',
    name: 'WhatsApp name',
    sourceAccounts: ['acc_1', 'acc_2'],
    sourceTypes: ['group', 'contact']
  });
  assert.equal(target.localName, 'Local name');
  assert.equal(target.name, 'WhatsApp name');
  assert.deepEqual(target.sourceAccounts, ['acc_1', 'acc_2']);
  assert.deepEqual(target.sourceTypes, ['group', 'contact']);
});
