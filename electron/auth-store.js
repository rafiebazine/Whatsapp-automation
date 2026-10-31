const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadBaileys } = require('./baileys-loader');

function encryptJson(value, key, bufferJson) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value, bufferJson.replacer), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptJson(payload, key, bufferJson) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(payload.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString('utf8'), bufferJson.reviver);
}

async function useEncryptedAuthState(folder, masterKey, accountId) {
  const { initAuthCreds, proto, BufferJSON } = await loadBaileys();
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'auth.enc');
  const key = Buffer.from(
    crypto.hkdfSync('sha256', masterKey, Buffer.from(accountId), Buffer.from('wa-group-manager-auth'), 32)
  );

  let state = null;
  if (fs.existsSync(file)) {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    state = decryptJson(payload, key, BufferJSON);
  }
  if (!state || !state.creds || !state.keys) {
    state = { creds: initAuthCreds(), keys: {} };
  }

  let writeChain = Promise.resolve();
  const persist = () => {
    writeChain = writeChain.then(async () => {
      fs.mkdirSync(folder, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(encryptJson(state, key, BufferJSON)), 'utf8');
      fs.renameSync(tmp, file);
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

module.exports = { useEncryptedAuthState };
