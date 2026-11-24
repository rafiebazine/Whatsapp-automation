const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Database } = require('../electron/db');
const { AuthVault } = require('../electron/vault');
const { normalizeRecoveryCode } = require('../electron/recovery-code');
const {
  useEncryptedAuthState,
  migrateEncryptedAuthState,
  _private: authStorePrivate
} = require('../electron/auth-store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-security-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('auth vault wraps a random database key and rotates recovery', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'auth-vault.json');
    const vault = new AuthVault(file, { scryptN: 1024, bcryptRounds: 4 });
    const created = vault.create({ username: 'operator', password: 'correct horse battery staple' });
    assert.equal(created.dek.length, 32);
    assert.match(created.recoveryCode, /^WGM-/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(vault.state.passwordHash.includes('correct'), false);

    const unlocked = vault.unlockWithPassword('operator', 'correct horse battery staple');
    assert.deepEqual(unlocked.dek, created.dek);

    const reset = vault.resetWithRecovery(created.recoveryCode, 'another long password here');
    assert.equal(reset.dek.length, 32);
    assert.notEqual(reset.recoveryCode, created.recoveryCode);
    assert.equal(normalizeRecoveryCode(reset.recoveryCode), normalizeRecoveryCode(reset.recoveryCode));
  } finally {
    cleanup(dir);
  }
});

test('auth vault records escalating password and recovery failures', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'auth-vault.json');
    const vault = new AuthVault(file, { scryptN: 1024, bcryptRounds: 4 });
    vault.create({ username: 'operator', password: 'correct horse battery staple' });
    for (let i = 0; i < 5; i += 1) {
      assert.throws(() => vault.unlockWithPassword('operator', 'wrong password'), /Incorrect username/);
    }
    assert.ok(vault.state.security.lockedUntil > Date.now());
    assert.throws(() => vault.unlockWithPassword('operator', 'correct horse battery staple'), /Too many attempts/);
  } finally {
    cleanup(dir);
  }
});

test('encrypted database round-trips, rejects wrong keys, and refuses writes while locked', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'db.json');
    const key = crypto.randomBytes(32);
    const db = new Database(file);
    db.useEncryptedData({ accounts: [{ id: 'acc_1', alias: 'Alpha', authFolder: 'acc_1' }] }, key);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(envelope.format, 'wgm-encrypted-db');
    assert.equal(envelope.version, 2);
    assert.equal('security' in envelope, false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

    const reopened = new Database(file);
    reopened.unlock(key);
    assert.equal(reopened.data.accounts[0].alias, 'Alpha');
    assert.equal(Buffer.from(reopened.data.security.sessionMasterKey, 'base64').length, 32);

    const wrong = new Database(file);
    assert.throws(() => wrong.unlock(crypto.randomBytes(32)), (error) => error.code === 'db_decrypt_failed');

    reopened.lock();
    reopened.data.accounts.push({ id: 'acc_2', authFolder: 'acc_2' });
    assert.equal(reopened.save(), false);
    const unchanged = new Database(file);
    unchanged.unlock(key);
    assert.equal(unchanged.data.accounts.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('auth-store re-encrypts session state from the legacy key to the session key', async () => {
  const dir = tempDir();
  try {
    const oldKey = crypto.randomBytes(32);
    const newKey = crypto.randomBytes(32);
    const folder = path.join(dir, 'acc_1');
    const state = await useEncryptedAuthState(folder, oldKey, 'acc_1');
    assert.ok(state.state.creds);
    const before = JSON.parse(fs.readFileSync(path.join(folder, 'auth.enc'), 'utf8'));
    assert.equal(before.version, 2);
    assert.equal(await migrateEncryptedAuthState(folder, oldKey, newKey, 'acc_1'), true);
    const reopened = await useEncryptedAuthState(folder, newKey, 'acc_1');
    assert.ok(reopened.state.creds);
    assert.equal(fs.statSync(path.join(folder, 'auth.enc')).mode & 0o777, 0o600);
    await assert.rejects(() => useEncryptedAuthState(folder, oldKey, 'acc_1'));
  } finally {
    cleanup(dir);
  }
});

test('migrates a legacy plaintext database to an encrypted envelope', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'db.json');
    const legacy = new Database(file);
    legacy.load();
    legacy.data.settings.dailyCap = 77;
    legacy.save();
    legacy.useEncryptedData(legacy.data, crypto.randomBytes(32));
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.includes('wgm-encrypted-db'));
    assert.ok(!raw.includes('dailyCap'));
    const reopened = new Database(file);
    assert.equal(reopened.inspect().kind, 'encrypted');
  } finally {
    cleanup(dir);
  }
});

test('refuses to replace a corrupt encrypted database', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'db.json');
    const corrupt = JSON.stringify({ format: 'wgm-encrypted-db', version: 2, cipher: 'aes-256-gcm' });
    fs.writeFileSync(file, corrupt);
    const db = new Database(file);
    assert.throws(() => db.load(), (error) => error.code === 'db_corrupt');
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  } finally {
    cleanup(dir);
  }
});

test('auth-store envelope authenticates account id and migrates v1 payloads', () => {
  const bufferJson = { replacer: null, reviver: null };
  const key = crypto.randomBytes(32);
  const value = { creds: { registrationId: 1 }, keys: { preKey: { a: { private: 'x' } } } };
  const envelope = authStorePrivate.encryptJson(value, key, bufferJson, 'acc_1');
  assert.equal(envelope.version, 2);
  assert.deepEqual(authStorePrivate.decryptJson(envelope, key, bufferJson, 'acc_1'), value);
  assert.throws(() => authStorePrivate.decryptJson(envelope, key, bufferJson, 'acc_2'));

  const legacyIv = crypto.randomBytes(12);
  const legacyCipher = crypto.createCipheriv('aes-256-gcm', key, legacyIv);
  const legacyCiphertext = Buffer.concat([
    legacyCipher.update(Buffer.from(JSON.stringify(value))),
    legacyCipher.final()
  ]);
  const legacy = {
    version: 1,
    iv: legacyIv.toString('base64'),
    tag: legacyCipher.getAuthTag().toString('base64'),
    data: legacyCiphertext.toString('base64')
  };
  assert.deepEqual(authStorePrivate.decryptJson(legacy, key, bufferJson, 'acc_1'), value);
});
