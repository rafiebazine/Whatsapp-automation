const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSpreadsheet } = require('../electron/spreadsheet');

test('parses phone numbers, LIDs, names, and stats', () => {
  const csv = [
    'number,name',
    '+212 612-345-678,Amina',
    '212699999999,',
    '222@lid,LID member',
    'not-a-number,Bad row',
    '+212612345678,Duplicate'
  ].join('\n');
  const parsed = parseSpreadsheet('contacts.csv', Buffer.from(csv));
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.stats.valid, 3);
  assert.equal(parsed.stats.invalid, 1);
  assert.equal(parsed.stats.duplicate, 1);
  assert.deepEqual(parsed.rows[0], {
    number: '+212612345678',
    jid: '212612345678@s.whatsapp.net',
    name: 'Amina'
  });
  assert.deepEqual(parsed.rows[1], {
    number: '+212699999999',
    jid: '212699999999@s.whatsapp.net',
    name: ''
  });
  assert.deepEqual(parsed.rows[2], {
    number: '222@lid',
    jid: '222@lid',
    name: 'LID member'
  });
});

test('parses headerless rows and rejects unsafe names', () => {
  const csv = ['+212612345678,212699999999', '212600000001,Real Name'].join('\n');
  const parsed = parseSpreadsheet('contacts.csv', Buffer.from(csv));
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].name, '');
  assert.equal(parsed.rows[1].name, 'Real Name');
});

test('rejects unsupported files and files without valid recipients', () => {
  assert.throws(
    () => parseSpreadsheet('contacts.xls', Buffer.from('number,name\n+212612345678,Amina')),
    /Unsupported file type/
  );
  assert.throws(
    () => parseSpreadsheet('contacts.csv', Buffer.from('number,name\nbad,Bad')),
    /No valid phone numbers/
  );
  assert.throws(
    () => parseSpreadsheet('contacts.csv', Buffer.alloc(0)),
    /empty/
  );
});
