const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Database } = require('./db');
const { migrateEncryptedAuthState } = require('./auth-store');
const { writeFileAtomicPrivate } = require('./secure-fs');

function deriveLegacyKey(password, saltHex) {
  return Buffer.from(crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32));
}

function safeAuthFolder(account) {
  const accountId = String((account && account.id) || '');
  const folder = String((account && account.authFolder) || accountId);
  if (!/^acc_[A-Za-z0-9-]{1,64}$/.test(folder) || folder !== accountId) return null;
  return folder;
}

async function migrateLegacySessions({ accounts, sessionsRoot, oldKey, newKey }) {
  const result = { migrated: 0, relink: 0 };
  for (const account of accounts || []) {
    const folderName = safeAuthFolder(account);
    if (!folderName || !oldKey) {
      account.needsRelink = true;
      account.lastError = 'Re-link this account once; its legacy session could not be migrated.';
      result.relink += 1;
      continue;
    }
    try {
      const changed = await migrateEncryptedAuthState(
        path.join(sessionsRoot, folderName),
        oldKey,
        newKey,
        account.id
      );
      if (changed) result.migrated += 1;
      else {
        account.needsRelink = true;
        account.lastError = 'Re-link this account once; no legacy session was found.';
        result.relink += 1;
      }
    } catch (error) {
      account.needsRelink = true;
      account.lastError = 'Re-link this account once; its legacy session could not be migrated.';
      result.relink += 1;
    }
  }
  return result;
}

async function encryptLegacyDatabase({ db, filePath, dek, oldKey = null, sessionsRoot }) {
  const newMasterKey = crypto.randomBytes(32);
  const migration = await migrateLegacySessions({
    accounts: db.data.accounts,
    sessionsRoot,
    oldKey,
    newKey: newMasterKey
  });
  db.data.auth = null;
  db.data.security = {
    ...(db.data.security || {}),
    sessionMasterKey: newMasterKey.toString('base64')
  };
  db.useEncryptedData(db.data, dek);
  const verifier = new Database(filePath);
  const verified = verifier.unlock(Buffer.from(dek));
  if (!verified || !verified.security || !verified.security.sessionMasterKey) {
    throw new Error('The encrypted database could not be verified after migration.');
  }
  const backup = `${filePath}.migrated-${Date.now()}.enc`;
  writeFileAtomicPrivate(backup, fs.readFileSync(filePath, 'utf8'));
  return migration;
}

module.exports = {
  deriveLegacyKey,
  safeAuthFolder,
  migrateLegacySessions,
  encryptLegacyDatabase
};
