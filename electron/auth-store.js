const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadBaileys } = require('./baileys-loader');
const { ensurePrivateDir, writeFileAtomicPrivate } = require('./secure-fs');

const AUTH_FORMAT_VERSION = 2;

function authAad(accountId) {
  return Buffer.from(`wgm-auth-v2|${accountId}`, 'utf8');
}

function encryptJson(value, key, bufferJson, accountId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (accountId) cipher.setAAD(authAad(accountId));
  const plaintext = Buffer.from(JSON.stringify(value, bufferJson.replacer), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: AUTH_FORMAT_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptJson(payload, key, bufferJson, accountId) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid encrypted auth state.');
  const iv = Buffer.from(String(payload.iv || ''), 'base64');
  const tag = Buffer.from(String(payload.tag || ''), 'base64');
  const data = Buffer.from(String(payload.data || ''), 'base64');
  if (iv.length !== 12 || tag.length !== 16 || !data.length) {
    throw new Error('Invalid encrypted auth state envelope.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (Number(payload.version) >= 2 && accountId) decipher.setAAD(authAad(accountId));
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'), bufferJson.reviver);
}

function authKey(masterKey, accountId) {
  return Buffer.from(
    crypto.hkdfSync('sha256', masterKey, Buffer.from(accountId), Buffer.from('wa-group-manager-auth'), 32)
  );
}

async function readAuthState(file, masterKey, accountId, bufferJson) {
  if (!fs.existsSync(file)) return null;
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  return decryptJson(payload, authKey(masterKey, accountId), bufferJson, accountId);
}

async function useEncryptedAuthState(folder, masterKey, accountId) {
  const { initAuthCreds, proto, BufferJSON } = await loadBaileys();
  ensurePrivateDir(folder);
  const file = path.join(folder, 'auth.enc');
  const key = authKey(masterKey, accountId);

  let state = null;
  if (fs.existsSync(file)) {
    state = await readAuthState(file, masterKey, accountId, BufferJSON);
  }
  if (!state || !state.creds || !state.keys) {
    state = { creds: initAuthCreds(), keys: {} };
  }

  let writeChain = Promise.resolve();
  const persist = () => {
    writeChain = writeChain.then(async () => {
      ensurePrivateDir(folder);
      writeFileAtomicPrivate(file, JSON.stringify(encryptJson(state, key, BufferJSON, accountId)));
    }).catch((error) => {
      console.error('Failed to persist encrypted auth state:', error);
    });
    return writeChain;
  };

  await persist();

  const creds = state.creds;
  const keys = {
    get: (type, ids) => {
      const result = {};
      for (const id of ids) {
        let value = state.keys[type] && state.keys[type][id];
        if (value && type === 'app-state-sync-key') {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        result[id] = value;
      }
      return result;
    },
    set: async (data) => {
      for (const category of Object.keys(data)) {
        if (!state.keys[category]) state.keys[category] = {};
        for (const id of Object.keys(data[category])) {
          const value = data[category][id];
          if (value) state.keys[category][id] = value;
          else delete state.keys[category][id];
        }
      }
      await persist();
    }
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      state.creds = creds;
      await persist();
    }
  };
}

async function migrateEncryptedAuthState(folder, oldMasterKey, newMasterKey, accountId) {
  const file = path.join(folder, 'auth.enc');
  if (!fs.existsSync(file)) return false;
  const { BufferJSON } = await loadBaileys();
  const state = await readAuthState(file, oldMasterKey, accountId, BufferJSON);
  if (!state) return false;
  const key = authKey(newMasterKey, accountId);
  writeFileAtomicPrivate(file, JSON.stringify(encryptJson(state, key, BufferJSON, accountId)));
  return true;
}


module.exports = {
  useEncryptedAuthState,
  migrateEncryptedAuthState,
  _private: {
    encryptJson,
    decryptJson,
    authKey
  }
};
