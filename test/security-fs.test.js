const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mock } = require('node:test');
const {
  ensurePrivateDir,
  writeFileAtomicPrivate,
  readFilePrivate,
  _private
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

test('failed atomic writes remove temporary files and preserve the original', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'state.json');
    writeFileAtomicPrivate(file, 'original');
    const original = fs.readFileSync(file, 'utf8');
    mock.method(fs, 'renameSync', () => {
      throw Object.assign(new Error('rename failed'), { code: 'EACCES' });
    });
    try {
      assert.throws(() => writeFileAtomicPrivate(file, 'replacement'), /rename failed/);
    } finally {
      mock.restoreAll();
    }
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('post-commit failures restore the original file', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'state.json');
    writeFileAtomicPrivate(file, 'original');
    const realFsync = fs.fsyncSync;
    let calls = 0;
    mock.method(fs, 'fsyncSync', (fd) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('directory fsync failed'), { code: 'EIO' });
      return realFsync(fd);
    });
    try {
      assert.throws(() => writeFileAtomicPrivate(file, 'replacement'), /directory fsync failed/);
    } finally {
      mock.restoreAll();
    }
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses to replace symbolic links', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir();
  try {
    const outside = path.join(dir, 'outside.json');
    fs.writeFileSync(outside, 'outside');
    const link = path.join(dir, 'state.json');
    fs.symlinkSync(outside, link);
    assert.throws(
      () => writeFileAtomicPrivate(link, 'attacker controlled'),
      (error) => error.code === 'unsafe_symlink'
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('permission hardening failures are propagated', () => {
  assert.throws(
    () => _private.chmodPrivate(path.join(os.tmpdir(), 'wgm-missing-target'), 0o600),
    (error) => error.code === 'permissions_failed'
  );
});

test('rejects writes outside an explicit approved root', () => {
  const dir = tempDir();
  try {
    const outside = path.join(os.tmpdir(), `wgm-outside-${Date.now()}.json`);
    assert.equal(fs.existsSync(outside), false);
    assert.throws(
      () => writeFileAtomicPrivate(outside, 'attacker controlled', 'utf8', { root: dir }),
      (error) => error.code === 'unsafe_path'
    );
    assert.equal(fs.existsSync(outside), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects symlinked parent components under an approved root', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir();
  let outside = null;
  try {
    outside = path.join(os.tmpdir(), `wgm-link-target-${Date.now()}`);
    fs.mkdirSync(outside);
    const link = path.join(dir, 'linked');
    fs.symlinkSync(outside, link);
    assert.throws(
      () => writeFileAtomicPrivate(path.join(link, 'state.json'), 'attacker controlled', 'utf8', { root: dir }),
      (error) => error.code === 'unsafe_symlink'
    );
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (outside) fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('rejects reads outside an explicit approved root', () => {
  const dir = tempDir();
  const outside = path.join(dir, 'outside.json');
  try {
    fs.writeFileSync(outside, 'outside');
    assert.throws(
      () => readFilePrivate(outside, 'utf8', { root: path.join(dir, 'approved') }),
      (error) => error.code === 'unsafe_path'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
