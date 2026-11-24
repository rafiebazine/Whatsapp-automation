const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSpreadsheet } = require('../electron/spreadsheet');
const { importContacts } = require('../electron/contact-import');
const { Database } = require('../electron/db');
const { sanitizeContactName } = require('../src/shared/identity');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('rejects aggressively compressed xlsx archives before parsing', () => {
  const name = Buffer.from('a');
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0, 8);
  central.writeUInt32LE(10, 20);
  central.writeUInt32LE(100000, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(0, 16);
  const buffer = Buffer.concat([central, eocd]);
  assert.throws(() => parseSpreadsheet('bomb.xlsx', buffer), /compressed too aggressively/);
});

test('rejects oversized CSV row counts and cells', () => {
  assert.throws(
    () => parseSpreadsheet('huge.csv', Buffer.from(`${'\n'.repeat(50001)}`)),
    /too many rows/
  );
  assert.throws(
    () => parseSpreadsheet('long.csv', Buffer.from(`${'a'.repeat(1001)},Name\n`)),
    /cell is too long/
  );
});

test('skips contact import rows with too many fields or oversized values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-import-'));
  try {
    const db = new Database(path.join(dir, 'db.json'));
    db.load();
    const row = { number: '0550123456', name: 'Valid' };
    for (let i = 0; i < 10; i += 1) row[`extra${i}`] = 'x';
    const result = importContacts(db, [row, { number: '0550123457', name: 'x'.repeat(1001) }]);
    assert.equal(result.imported, 0);
    assert.equal(result.skipped, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitizes control characters and long contact names', () => {
  assert.equal(sanitizeContactName('Amina\u0000'), '');
  assert.equal(sanitizeContactName('x'.repeat(201)), '');
  assert.equal(sanitizeContactName('Amina'), 'Amina');
});
