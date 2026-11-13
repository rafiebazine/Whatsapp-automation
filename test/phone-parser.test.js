const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const {
  parsePhoneNumber,
  normalizePhone,
  formatPhone,
  jidFromPhone,
  identityKeys
} = require('../src/shared/identity');
const { parseSpreadsheet } = require('../electron/spreadsheet');

test('normalizes Algerian local and international mobile formats', () => {
  const variants = ['0551234567', '+213551234567', '00213551234567', '213551234567'];
  for (const value of variants) {
    const parsed = parsePhoneNumber(value);
    assert.equal(parsed.valid, true, value);
    assert.equal(parsed.country, 'DZ', value);
    assert.equal(parsed.canonical, '+213551234567', value);
    assert.equal(parsed.digits, '213551234567', value);
    assert.equal(parsed.national, '0551234567', value);
    assert.equal(normalizePhone(value), '+213551234567', value);
    assert.equal(formatPhone(value), '+213551234567', value);
    assert.equal(jidFromPhone(value), '213551234567@s.whatsapp.net', value);
  }
});

test('preserves existing non-Algerian international numbers', () => {
  assert.equal(normalizePhone('+212 612-345-678'), '+212612345678');
  assert.equal(normalizePhone('00212612345678'), '+212612345678');
  assert.equal(normalizePhone('212612345678'), '+212612345678');
  const parsed = parsePhoneNumber('+33612345678');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.country, 'INTL');
  assert.equal(parsed.canonical, '+33612345678');
});

test('rejects ambiguous and malformed inputs with reasons', () => {
  assert.equal(parsePhoneNumber('551234567').reason, 'ambiguous');
  assert.equal(parsePhoneNumber('05512345').reason, 'invalid_algerian');
  assert.equal(parsePhoneNumber('+21355123456').reason, 'invalid_algerian');
  assert.equal(parsePhoneNumber('not a phone').reason, 'invalid_characters');
  assert.equal(parsePhoneNumber('123').reason, 'too_short');
  assert.equal(normalizePhone('551234567'), '');
});

test('identity keys canonicalize Algerian local phone input', () => {
  const keys = identityKeys({ jid: '213551234567@s.whatsapp.net', phoneNumber: '0551234567' });
  assert.ok(keys.has('213551234567@s.whatsapp.net'));
});

test('spreadsheet imports Algerian local numbers and warns when Excel drops a zero', () => {
  const csv = parseSpreadsheet('contacts.csv', Buffer.from('number,name\n0551234567,Amina'));
  assert.equal(csv.rows[0].number, '+213551234567');
  assert.equal(csv.rows[0].jid, '213551234567@s.whatsapp.net');
  assert.equal(csv.stats.assumedLocalZero, 0);

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([[551234567, 'Excel']]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Contacts');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const parsed = parseSpreadsheet('contacts.xlsx', buffer);
  assert.equal(parsed.rows[0].number, '+213551234567');
  assert.equal(parsed.stats.assumedLocalZero, 1);
  assert.equal(parsed.stats.warnings.length, 1);
});
