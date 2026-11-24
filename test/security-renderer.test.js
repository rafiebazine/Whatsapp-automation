const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

test('renderer excludes dynamic code execution and unsafe URL schemes', () => {
  assert.ok(!/\beval\s*\(/.test(app));
  assert.ok(!/\bnew\s+Function\s*\(/.test(app));
  assert.ok(!/javascript:/i.test(app));
});

test('QR image insertion is validated before being used as an image source', () => {
  const validator = app.indexOf('function safeQrData');
  const imageUse = app.indexOf('<img src="${qr}"');
  assert.ok(validator >= 0);
  assert.ok(imageUse > validator);
  assert.match(app, /return account \? safeQrData\(account\.qr\) : null/);
});

test('user-controlled text is escaped before innerHTML template insertion', () => {
  assert.ok(app.includes('function esc('));
  assert.ok(app.includes('${esc(message)}'));
  assert.ok(app.includes('${esc(group.name)}'));
  assert.ok(app.includes('${esc(account.id)}'));
});
