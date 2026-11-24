const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ensurePrivateDir,
  writeFileAtomicPrivate,
  readFilePrivate
} = require('../electron/secure-fs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-fs-'));
}

test('creates private directories and files with restrictive modes', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir();
  try {
    const nested = path.join(dir, 'a', 'b');
    ensurePrivateDir(nested);
    assert.equal(fs.statSync(nested).mode & 0o777, 0o700);
    const file = path.join(nested, 'state.json');
    writeFileAtomicPrivate(file, '{"ok":true}');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(readFilePrivate(file), '{"ok":true}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic writes replace content without leaving temporary files', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'state.json');
    writeFileAtomicPrivate(file, 'first');
    writeFileAtomicPrivate(file, 'second');
    assert.equal(fs.readFileSync(file, 'utf8'), 'second');
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
