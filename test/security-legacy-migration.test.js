const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Database } = require('../electron/db');
const { useEncryptedAuthState, _private: authStorePrivate } = require('../electron/auth-store');
const { writeFileAtomicPrivate } = require('../electron/secure-fs');
const { deriveLegacyKey, encryptLegacyDatabase } = require('../electron/legacy-migration');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-legacy-migration-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function legacyDatabase(dir) {
  const filePath = path.join(dir, 'db.json');
  const db = new Database(filePath);
  db.load();
  db.data.accounts = [{
    id: 'acc_1',
    authFolder: 'acc_1',
    alias: 'Legacy account',
    status: 'disconnected'
  }];
  db.data.auth = {
    username: 'operator',
    passwordHash: 'legacy-hash',
    kdfSalt: crypto.randomBytes(16).toString('hex')
  };
  db.save();
  return { db, filePath };
}

test('legacy migration encrypts the database and re-encrypts session credentials', async () => {
  const dir = tempDir();
  try {
    const { db, filePath } = legacyDatabase(dir);
    const sessionsRoot = path.join(dir, 'sessions');
    const oldKey = deriveLegacyKey('legacy password', db.data.auth.kdfSalt);
    const legacyValue = { creds: { registrationId: 123 }, keys: { preKey: { a: { private: 'x' } } } };
    const legacyKey = authStorePrivate.authKey(oldKey, 'acc_1');
    const legacyIv = crypto.randomBytes(12);
    const legacyCipher = crypto.createCipheriv('aes-256-gcm', legacyKey, legacyIv);
    const legacyCiphertext = Buffer.concat([
      legacyCipher.update(Buffer.from(JSON.stringify(legacyValue))),
      legacyCipher.final()
    ]);
    const legacyPayload = {
      version: 1,
      iv: legacyIv.toString('base64'),
      tag: legacyCipher.getAuthTag().toString('base64'),
      data: legacyCiphertext.toString('base64')
    };
    const authFile = path.join(sessionsRoot, 'acc_1', 'auth.enc');
    writeFileAtomicPrivate(authFile, JSON.stringify(legacyPayload));

    const dek = crypto.randomBytes(32);
    const result = await encryptLegacyDatabase({ db, filePath, dek, oldKey, sessionsRoot });

    assert.deepEqual(result, { migrated: 1, relink: 0 });
    assert.equal(db.data.auth, null);
    assert.equal(db.data.security.sessionMasterKey.length, 44);
    assert.equal(db.data.accounts[0].needsRelink, undefined);

    const raw = fs.readFileSync(filePath, 'utf8');
    assert.ok(raw.includes('wgm-encrypted-db'));
    assert.ok(!raw.includes('legacy-hash'));
    assert.ok(!raw.includes('kdfSalt'));
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('db.json.migrated-') && name.endsWith('.enc')));

    const newMasterKey = Buffer.from(db.data.security.sessionMasterKey, 'base64');
    const migrated = await useEncryptedAuthState(path.join(sessionsRoot, 'acc_1'), newMasterKey, 'acc_1');
    assert.equal(migrated.state.creds.registrationId, 123);
    assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).version, 2);
    await assert.rejects(() => useEncryptedAuthState(path.join(sessionsRoot, 'acc_1'), oldKey, 'acc_1'));
  } finally {
    cleanup(dir);
  }
});

test('legacy migration marks accounts for relinking when no legacy session exists', async () => {
  const dir = tempDir();
  try {
    const { db, filePath } = legacyDatabase(dir);
    const sessionsRoot = path.join(dir, 'sessions');
    const oldKey = deriveLegacyKey('legacy password', db.data.auth.kdfSalt);
    const result = await encryptLegacyDatabase({ db, filePath, dek: crypto.randomBytes(32), oldKey, sessionsRoot });
    assert.deepEqual(result, { migrated: 0, relink: 1 });
    assert.equal(db.data.accounts[0].needsRelink, true);
    assert.match(db.data.accounts[0].lastError, /no legacy session/);
  } finally {
    cleanup(dir);
  }
});
