const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadBaileys } = require('./baileys-loader');
const secureFs = require('./secure-fs');
const { ensurePrivateDir, writeFileAtomicPrivate } = secureFs;

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

async function readAuthState(file, masterKey, accountId, bufferJson, options = {}) {
  if (!fs.existsSync(file)) return null;
  const raw = secureFs.readFilePrivate(file, 'utf8', {
    root: options.root || path.dirname(file),
    maxBytes: 16 * 1024 * 1024
  });
  const payload = JSON.parse(raw);
  return decryptJson(payload, authKey(masterKey, accountId), bufferJson, accountId);
}

const RETRYABLE_WRITE_CODES = new Set(['EACCES', 'EPERM', 'EBUSY', 'EAGAIN', 'ENOSPC', 'EIO', 'EMFILE', 'ENFILE']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryableWriteFailure(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (RETRYABLE_WRITE_CODES.has(current.code)) return true;
    current = current.cause;
  }
  return false;
}

function persistenceFailure(cause) {
  const error = new Error('The encrypted session state could not be saved to disk.');
  error.code = 'auth_persist_failed';
  error.cause = cause;
  return error;
}

async function useEncryptedAuthState(folder, masterKey, accountId, options = {}) {
  const fsOptions = { root: options.root ? path.resolve(options.root) : path.dirname(folder) };
  const io = {
    ensurePrivateDir: (target, ioOptions = {}) =>
      (options.ensurePrivateDir || ensurePrivateDir)(target, { ...fsOptions, ...ioOptions }),
    writeFileAtomicPrivate: (target, data, encoding = 'utf8', ioOptions = {}) =>
      (options.writeFileAtomicPrivate || writeFileAtomicPrivate)(target, data, encoding, {
        ...fsOptions,
        ...ioOptions
      }),
    loadBaileys: options.loadBaileys || loadBaileys,
    encryptJson: options.encryptJson || encryptJson,
    retries: Number.isInteger(options.retries) ? options.retries : 3,
    retryDelayMs: Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 200
  };
  const { initAuthCreds, proto, BufferJSON } = await io.loadBaileys();
  io.ensurePrivateDir(folder);
  const file = path.join(folder, 'auth.enc');
  const key = authKey(masterKey, accountId);

  let state = null;
  if (fs.existsSync(file)) {
    state = await readAuthState(file, masterKey, accountId, BufferJSON, fsOptions);
    if (!state || !state.creds || !state.keys) {
      const error = new Error('The encrypted session state is missing required fields.');
      error.code = 'auth_corrupt';
      throw error;
    }
  }
  if (!state) {
    state = { creds: initAuthCreds(), keys: {} };
  }

  let writeChain = Promise.resolve();
  const persist = () => {
    const run = writeChain.then(async () => {
      let lastFailure = null;
      for (let attempt = 0; attempt <= io.retries; attempt += 1) {
        try {
          io.ensurePrivateDir(folder);
          const payload = io.encryptJson(state, key, BufferJSON, accountId);
          io.writeFileAtomicPrivate(file, JSON.stringify(payload));
          return;
        } catch (error) {
          lastFailure = error;
          if (attempt >= io.retries || !retryableWriteFailure(error)) break;
          await sleep(io.retryDelayMs * (attempt + 1));
        }
      }
      throw persistenceFailure(lastFailure);
    });
    writeChain = run.catch(() => {});
    return run;
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

async function migrateEncryptedAuthState(folder, oldMasterKey, newMasterKey, accountId, options = {}) {
  const fsOptions = { root: options.root ? path.resolve(options.root) : path.dirname(folder) };
  const io = {
    loadBaileys: options.loadBaileys || loadBaileys,
    writeFileAtomicPrivate: (target, data, encoding = 'utf8', ioOptions = {}) =>
      (options.writeFileAtomicPrivate || writeFileAtomicPrivate)(target, data, encoding, {
        ...fsOptions,
        ...ioOptions
      })
  };
  const file = path.join(folder, 'auth.enc');
  if (!fs.existsSync(file)) return false;
  const { BufferJSON } = await io.loadBaileys();
  const state = await readAuthState(file, oldMasterKey, accountId, BufferJSON, fsOptions);
  if (!state) return false;
  const key = authKey(newMasterKey, accountId);
  try {
    io.writeFileAtomicPrivate(file, JSON.stringify(encryptJson(state, key, BufferJSON, accountId)));
  } catch (error) {
    throw persistenceFailure(error);
  }
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
