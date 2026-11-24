const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { writeFileAtomicPrivate, readFilePrivate, ensurePrivateDir } = require('./secure-fs');
const { generateRecoveryCode, normalizeRecoveryCode } = require('./recovery-code');

const VAULT_FORMAT = 'wgm-vault';
const VAULT_VERSION = 1;
const DEFAULT_SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 };
const DEFAULT_BCRYPT_ROUNDS = 12;
const PASSWORD_MIN_CHARS = 12;
const PASSWORD_MAX_BYTES = 72;
const LOCK_THRESHOLD = 5;
const LOCK_STEPS_MS = [30000, 120000, 300000, 900000, 1800000, 3600000];

function vaultError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validatePassword(password) {
  if (typeof password !== 'string') {
    throw vaultError('password_policy', 'Password must be text.');
  }
  if (password.length < PASSWORD_MIN_CHARS) {
    throw vaultError('password_policy', `Password must be at least ${PASSWORD_MIN_CHARS} characters.`);
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    throw vaultError(
      'password_policy',
      `Password must be at most ${PASSWORD_MAX_BYTES} bytes (UTF-8).`
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(password)) {
    throw vaultError('password_policy', 'Password must not contain control characters.');
  }
  return true;
}

function isWeakPassword(password) {
  return typeof password !== 'string' || password.length < PASSWORD_MIN_CHARS;
}

function normalizeKdf(input) {
  if (!input || typeof input !== 'object') throw vaultError('vault_corrupt', 'Invalid key derivation parameters.');
  const N = Number(input.N);
  const r = Number(input.r);
  const p = Number(input.p);
  const keylen = Number(input.keylen);
  if (!Number.isInteger(N) || N < 1024 || N > 1048576 || (N & (N - 1)) !== 0) {
    throw vaultError('vault_corrupt', 'Invalid scrypt N parameter.');
  }
  if (!Number.isInteger(r) || r < 1 || r > 32) throw vaultError('vault_corrupt', 'Invalid scrypt r parameter.');
  if (!Number.isInteger(p) || p < 1 || p > 16) throw vaultError('vault_corrupt', 'Invalid scrypt p parameter.');
  if (keylen !== 32) throw vaultError('vault_corrupt', 'Invalid key length.');
  if (input.name !== 'scrypt') throw vaultError('vault_corrupt', 'Unsupported key derivation function.');
  const salt = String(input.salt || '');
  if (!/^[0-9a-f]{32,128}$/i.test(salt) || salt.length % 2 !== 0) {
    throw vaultError('vault_corrupt', 'Invalid KDF salt.');
  }
  return { name: 'scrypt', N, r, p, keylen, salt };
}

function deriveKek(secret, kdf) {
  const params = normalizeKdf(kdf);
  return Buffer.from(crypto.scryptSync(String(secret), Buffer.from(params.salt, 'hex'), params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: Math.max(256 * 1024 * 1024, 256 * params.N * params.r)
  }));
}

function aadFor(purpose, username) {
  return Buffer.from(`wgm-vault-v1|${purpose}|${username}`, 'utf8');
}

function wrapKey(kek, key, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(key), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

function unwrapKey(kek, wrapped, aad) {
  if (!wrapped || typeof wrapped !== 'object') throw vaultError('vault_corrupt', 'Missing wrapped key.');
  const iv = Buffer.from(String(wrapped.iv || ''), 'base64');
  const tag = Buffer.from(String(wrapped.tag || ''), 'base64');
  const data = Buffer.from(String(wrapped.data || ''), 'base64');
  if (iv.length !== 12 || tag.length !== 16 || !data.length) {
    throw vaultError('vault_corrupt', 'Invalid wrapped key.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (error) {
    throw vaultError('invalid_credentials', 'Incorrect username, password, or recovery key.');
  }
}

function defaultSecurity() {
  return {
    failedAttempts: 0,
    lastFailedAt: 0,
    lockedUntil: 0,
    recoveryFailedAttempts: 0,
    recoveryLastFailedAt: 0,
    recoveryLockedUntil: 0
  };
}

function validateVault(state) {
  if (!state || typeof state !== 'object' || state.format !== VAULT_FORMAT || Number(state.version) !== VAULT_VERSION) {
    throw vaultError('vault_corrupt', 'The local security file is invalid.');
  }
  if (typeof state.username !== 'string' || state.username.length < 3 || state.username.length > 40) {
    throw vaultError('vault_corrupt', 'The local security file has an invalid username.');
  }
  if (typeof state.passwordHash !== 'string' || !/^\$2[aby]\$/.test(state.passwordHash)) {
    throw vaultError('vault_corrupt', 'The local security file has an invalid password hash.');
  }
  normalizeKdf(state.passwordKdf);
  normalizeKdf(state.recoveryKdf);
  if (!state.passwordWrap || !state.recoveryWrap) throw vaultError('vault_corrupt', 'Missing wrapped keys.');
  if (!state.security || typeof state.security !== 'object') state.security = defaultSecurity();
  state.security = { ...defaultSecurity(), ...state.security };
  return state;
}

class AuthVault {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.scryptN = Number(options.scryptN) || DEFAULT_SCRYPT.N;
    this.bcryptRounds = Number(options.bcryptRounds) || DEFAULT_BCRYPT_ROUNDS;
    this.writeFile = options.writeFile || ((file, data) => writeFileAtomicPrivate(file, data));
    this.state = null;
    this.dek = null;
  }

  persistState(state) {
    try {
      this.writeFile(this.filePath, JSON.stringify(state, null, 2));
    } catch (error) {
      const failure = vaultError('vault_persist_failed', 'The local security settings could not be saved to disk.');
      failure.cause = error;
      throw failure;
    }
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.state = null;
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(readFilePrivate(this.filePath, 'utf8', { maxBytes: 1024 * 1024 }));
    } catch (error) {
      if (error && error.code === 'vault_corrupt') throw error;
      throw vaultError('vault_corrupt', 'The local security file could not be read.');
    }
    this.state = validateVault(parsed);
    return this.state;
  }

  exists() {
    return Boolean(this.state) || fs.existsSync(this.filePath);
  }

  getUsername() {
    return this.state ? this.state.username : '';
  }

  hasDek() {
    return Boolean(this.dek);
  }

  create({ username, password, recoveryCode }) {
    if (this.exists()) throw vaultError('already_initialized', 'A local login already exists.');
    validatePassword(password);
    const cleanUser = String(username || '').trim();
    if (cleanUser.length < 3) throw vaultError('invalid_request', 'Username must be at least 3 characters.');
    if (cleanUser.length > 40) throw vaultError('invalid_request', 'Username must be 40 characters or fewer.');
    const dek = crypto.randomBytes(32);
    const recovery = recoveryCode || generateRecoveryCode();
    const normalizedRecovery = normalizeRecoveryCode(recovery);
    if (!normalizedRecovery) throw vaultError('invalid_request', 'Invalid recovery key.');
    const passwordKdf = {
      name: 'scrypt',
      salt: crypto.randomBytes(16).toString('hex'),
      N: this.scryptN,
      r: DEFAULT_SCRYPT.r,
      p: DEFAULT_SCRYPT.p,
      keylen: DEFAULT_SCRYPT.keylen
    };
    const recoveryKdf = {
      name: 'scrypt',
      salt: crypto.randomBytes(16).toString('hex'),
      N: this.scryptN,
      r: DEFAULT_SCRYPT.r,
      p: DEFAULT_SCRYPT.p,
      keylen: DEFAULT_SCRYPT.keylen
    };
    const nextState = {
      format: VAULT_FORMAT,
      version: VAULT_VERSION,
      username: cleanUser,
      passwordHash: bcrypt.hashSync(password, this.bcryptRounds),
      passwordKdf,
      passwordWrap: wrapKey(
        deriveKek(password, passwordKdf),
        dek,
        aadFor('password', cleanUser)
      ),
      recoveryKdf,
      recoveryWrap: wrapKey(
        deriveKek(normalizedRecovery, recoveryKdf),
        dek,
        aadFor('recovery', cleanUser)
      ),
      security: defaultSecurity(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.persistState(nextState);
    this.state = nextState;
    this.dek = Buffer.from(dek);
    return { dek: Buffer.from(dek), recoveryCode: recovery };
  }

  assertNotLocked(kind = 'password') {
    const security = this.state.security;
    const lockedUntil = kind === 'recovery' ? security.recoveryLockedUntil : security.lockedUntil;
    if (lockedUntil && lockedUntil > Date.now()) {
      const seconds = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
      throw vaultError('auth_locked', `Too many attempts. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`);
    }
  }

  recordFailure(kind = 'password') {
    const security = this.state.security;
    const previous = { ...security };
    const recovery = kind === 'recovery';
    const countKey = recovery ? 'recoveryFailedAttempts' : 'failedAttempts';
    const lastKey = recovery ? 'recoveryLastFailedAt' : 'lastFailedAt';
    const lockKey = recovery ? 'recoveryLockedUntil' : 'lockedUntil';
    security[countKey] = (security[countKey] || 0) + 1;
    security[lastKey] = Date.now();
    if (security[countKey] >= LOCK_THRESHOLD) {
      const step = Math.min(security[countKey] - LOCK_THRESHOLD, LOCK_STEPS_MS.length - 1);
      security[lockKey] = Math.max(security[lockKey] || 0, Date.now() + LOCK_STEPS_MS[step]);
    }
    try {
      this.persistState(this.state);
    } catch (error) {
      this.state.security = previous;
      throw error;
    }
  }

  resetFailures(kind = 'password') {
    const security = this.state.security;
    const previous = { ...security };
    if (kind === 'recovery') {
      security.recoveryFailedAttempts = 0;
      security.recoveryLastFailedAt = 0;
      security.recoveryLockedUntil = 0;
    } else {
      security.failedAttempts = 0;
      security.lastFailedAt = 0;
      security.lockedUntil = 0;
    }
    try {
      this.persistState(this.state);
    } catch (error) {
      this.state.security = previous;
      throw error;
    }
  }

  verifyPassword(username, password) {
    this.assertNotLocked('password');
    const validUser = String(username || '').trim() === this.state.username;
    const validPassword = bcrypt.compareSync(String(password || ''), this.state.passwordHash);
    if (!validUser || !validPassword) {
      this.recordFailure('password');
      throw vaultError('invalid_credentials', 'Incorrect username or password.');
    }
    this.resetFailures('password');
    return true;
  }

  unlockWithPassword(username, password) {
    this.verifyPassword(username, password);
    const kek = deriveKek(String(password), this.state.passwordKdf);
    this.dek = unwrapKey(kek, this.state.passwordWrap, aadFor('password', this.state.username));
    return { dek: Buffer.from(this.dek), mustChangePassword: isWeakPassword(password) };
  }

  unlockWithRecovery(code) {
    this.assertNotLocked('recovery');
    const normalized = normalizeRecoveryCode(code);
    if (!normalized) {
      this.recordFailure('recovery');
      throw vaultError('invalid_credentials', 'Invalid recovery key.');
    }
    const kek = deriveKek(normalized, this.state.recoveryKdf);
    try {
      this.dek = unwrapKey(kek, this.state.recoveryWrap, aadFor('recovery', this.state.username));
    } catch (error) {
      this.recordFailure('recovery');
      throw error;
    }
    try {
      this.resetFailures('recovery');
    } catch (error) {
      this.dek = null;
      throw error;
    }
    return { dek: Buffer.from(this.dek) };
  }

  changePassword(currentPassword, newPassword) {
    if (!this.dek) throw vaultError('not_unlocked', 'Unlock the app before changing the password.');
    this.verifyPassword(this.state.username, currentPassword);
    validatePassword(newPassword);
    const passwordKdf = {
      name: 'scrypt',
      salt: crypto.randomBytes(16).toString('hex'),
      N: this.scryptN,
      r: DEFAULT_SCRYPT.r,
      p: DEFAULT_SCRYPT.p,
      keylen: DEFAULT_SCRYPT.keylen
    };
    const recoveryCode = generateRecoveryCode();
    const normalizedRecovery = normalizeRecoveryCode(recoveryCode);
    const recoveryKdf = {
      name: 'scrypt',
      salt: crypto.randomBytes(16).toString('hex'),
      N: this.scryptN,
      r: DEFAULT_SCRYPT.r,
      p: DEFAULT_SCRYPT.p,
      keylen: DEFAULT_SCRYPT.keylen
    };
    const nextState = {
      ...this.state,
      passwordHash: bcrypt.hashSync(newPassword, this.bcryptRounds),
      passwordKdf,
      passwordWrap: wrapKey(deriveKek(newPassword, passwordKdf), this.dek, aadFor('password', this.state.username)),
      recoveryKdf,
      recoveryWrap: wrapKey(
        deriveKek(normalizedRecovery, recoveryKdf),
        this.dek,
        aadFor('recovery', this.state.username)
      ),
      updatedAt: new Date().toISOString()
    };
    this.persistState(nextState);
    this.state = nextState;
    return { recoveryCode, dek: Buffer.from(this.dek) };
  }

  resetWithRecovery(code, newPassword) {
    const { dek } = this.unlockWithRecovery(code);
    try {
      validatePassword(newPassword);
      const passwordKdf = {
        name: 'scrypt',
        salt: crypto.randomBytes(16).toString('hex'),
        N: this.scryptN,
        r: DEFAULT_SCRYPT.r,
        p: DEFAULT_SCRYPT.p,
        keylen: DEFAULT_SCRYPT.keylen
      };
      const recoveryCode = generateRecoveryCode();
      const normalizedRecovery = normalizeRecoveryCode(recoveryCode);
      const recoveryKdf = {
        name: 'scrypt',
        salt: crypto.randomBytes(16).toString('hex'),
        N: this.scryptN,
        r: DEFAULT_SCRYPT.r,
        p: DEFAULT_SCRYPT.p,
        keylen: DEFAULT_SCRYPT.keylen
      };
      const nextState = {
        ...this.state,
        passwordHash: bcrypt.hashSync(newPassword, this.bcryptRounds),
        passwordKdf,
        passwordWrap: wrapKey(deriveKek(newPassword, passwordKdf), dek, aadFor('password', this.state.username)),
        recoveryKdf,
        recoveryWrap: wrapKey(
          deriveKek(normalizedRecovery, recoveryKdf),
          dek,
          aadFor('recovery', this.state.username)
        ),
        updatedAt: new Date().toISOString()
      };
      this.persistState(nextState);
      this.state = nextState;
      return { recoveryCode, dek: Buffer.from(dek) };
    } catch (error) {
      this.dek = null;
      throw error;
    }
  }

  regenerateRecovery(password) {
    if (!this.dek) throw vaultError('not_unlocked', 'Unlock the app before generating a new recovery key.');
    this.verifyPassword(this.state.username, password);
    const recoveryCode = generateRecoveryCode();
    const normalizedRecovery = normalizeRecoveryCode(recoveryCode);
    const recoveryKdf = {
      name: 'scrypt',
      salt: crypto.randomBytes(16).toString('hex'),
      N: this.scryptN,
      r: DEFAULT_SCRYPT.r,
      p: DEFAULT_SCRYPT.p,
      keylen: DEFAULT_SCRYPT.keylen
    };
    const nextState = {
      ...this.state,
      recoveryKdf,
      recoveryWrap: wrapKey(
        deriveKek(normalizedRecovery, recoveryKdf),
        this.dek,
        aadFor('recovery', this.state.username)
      ),
      updatedAt: new Date().toISOString()
    };
    this.persistState(nextState);
    this.state = nextState;
    return { recoveryCode };
  }

  write() {
    ensurePrivateDir(path.dirname(this.filePath));
    this.persistState(this.state);
  }

  lock() {
    if (this.dek) {
      this.dek.fill(0);
      this.dek = null;
    }
  }
}

module.exports = {
  AuthVault,
  validatePassword,
  isWeakPassword,
  PASSWORD_MIN_CHARS,
  PASSWORD_MAX_BYTES,
  VAULT_FORMAT,
  VAULT_VERSION,
  _private: {
    deriveKek,
    wrapKey,
    unwrapKey,
    validateVault,
    defaultSecurity
  }
};
