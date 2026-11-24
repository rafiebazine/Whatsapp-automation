const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const WINDOWS_SYSTEM_SID = '*S-1-5-18';
const WINDOWS_ADMINISTRATORS_SID = '*S-1-5-32-544';
const hardenedWindowsDirs = new Set();

function secureError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function platformOf(options = {}) {
  return options.platform || process.platform;
}

function resolveWindowsPrincipal(options = {}) {
  if (options.principal) return options.principal;
  const exec = options.execFileSync || execFileSync;
  try {
    const output = exec('whoami', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true
    });
    const match = String(output || '').match(/"(S-1-[0-9-]+)"/);
    if (match) return `*${match[1]}`;
  } catch (error) {
    // Fall back to the environment-derived account name below.
  }
  const userName = process.env.USERNAME || (os.userInfo && os.userInfo().username);
  if (!userName) {
    throw secureError('acl_identity_unavailable', 'Could not determine the current Windows user for ACL hardening.');
  }
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${userName}` : String(userName);
}

function verifyWindowsAcl(target, options = {}) {
  if (options.verify === false) return true;
  const exec = options.execFileSync || execFileSync;
  let output;
  try {
    output = exec('icacls', [target], { encoding: 'utf8', windowsHide: true });
  } catch (error) {
    throw secureError('acl_verification_failed', `Could not verify Windows permissions on ${path.basename(target)}.`, error);
  }
  const text = String(output || '');
  if (/\(I\)/.test(text)) {
    throw secureError('acl_inherited', `Windows permissions on ${path.basename(target)} still contain inherited entries.`);
  }
  const principal = String(options.principal || '').replace(/^\*/, '');
  const userName = process.env.USERNAME || (os.userInfo && os.userInfo().username) || '';
  const domain = process.env.USERDOMAIN || '';
  const allowed = new Set([
    principal,
    WINDOWS_SYSTEM_SID.replace(/^\*/, ''),
    WINDOWS_ADMINISTRATORS_SID.replace(/^\*/, ''),
    'NT AUTHORITY\\SYSTEM',
    'BUILTIN\\Administrators',
    userName,
    userName && domain ? `${domain}\\${userName}` : ''
  ].filter(Boolean));
  const entries = text
    .split(/\r?\n/)
    .filter((line) => line.includes(':(') && !/^Successfully processed/i.test(line.trim()));
  if (entries.length === 0) {
    throw secureError('acl_unverified', `Windows permissions on ${path.basename(target)} could not be verified as restrictive.`);
  }
  if (!entries.some((entry) => entry.includes('(F)'))) {
    throw secureError('acl_unverified', `Windows permissions on ${path.basename(target)} could not be verified as restrictive.`);
  }
  for (const entry of entries) {
    if (!Array.from(allowed).some((name) => entry.includes(name))) {
      throw secureError('acl_unexpected_principal', `Windows permissions on ${path.basename(target)} include an unexpected principal.`);
    }
  }
  return true;
}

function hardenWindowsAcl(target, options = {}) {
  if (platformOf(options) !== 'win32') return target;
  const resolved = path.resolve(target);
  const cacheable = options.cache !== false;
  if (cacheable && hardenedWindowsDirs.has(resolved)) return target;
  const exec = options.execFileSync || execFileSync;
  const principal = resolveWindowsPrincipal(options);
  try {
    exec('icacls', [
      target,
      '/inheritance:r',
      '/grant:r',
      `${principal}:F`,
      `${WINDOWS_SYSTEM_SID}:F`,
      `${WINDOWS_ADMINISTRATORS_SID}:F`
    ], { stdio: 'ignore', windowsHide: true });
  } catch (error) {
    throw secureError('acl_failed', `Could not restrict Windows permissions on ${path.basename(target)}.`, error);
  }
  verifyWindowsAcl(target, { ...options, principal });
  if (cacheable) hardenedWindowsDirs.add(resolved);
  return target;
}

function chmodPrivate(target, mode, options = {}) {
  if (platformOf(options) === 'win32') return target;
  try {
    fs.chmodSync(target, mode);
  } catch (error) {
    throw secureError('permissions_failed', `Could not restrict permissions on ${path.basename(target)}.`, error);
  }
  return target;
}

function assertNoSymlinkComponents(target) {
  const resolved = path.resolve(target);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') return resolved;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw secureError('unsafe_symlink', `Refusing to use a symbolic link at ${path.basename(resolved)}.`);
  }
  return resolved;
}

function ensurePrivateDir(dir, options = {}) {
  assertNoSymlinkComponents(dir);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(dir);
  assertNoSymlinkComponents(dir);
  if (!stat.isDirectory()) {
    throw secureError('not_a_directory', `${path.basename(dir)} is not a directory.`);
  }
  chmodPrivate(dir, DIR_MODE, options);
  hardenWindowsAcl(dir, { ...options, cache: options.cache !== false });
  return dir;
}

function ensurePrivateFile(file, options = {}) {
  assertNoSymlinkComponents(file);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    throw secureError('unsafe_symlink', `Refusing to use a symbolic link at ${path.basename(file)}.`);
  }
  if (!stat.isFile()) {
    throw secureError('not_a_file', `${path.basename(file)} is not a regular file.`);
  }
  chmodPrivate(file, FILE_MODE, options);
  hardenWindowsAcl(file, { ...options, cache: false });
  return file;
}

function fsyncDirectory(dir, options = {}) {
  if (platformOf(options) === 'win32') return;
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    // Directory fsync is not available on every platform/filesystem.
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        // Ignore close failures after a best-effort sync.
      }
    }
  }
}

function writeFileAtomicPrivate(file, data, encoding = 'utf8', options = {}) {
  const dir = path.dirname(file);
  ensurePrivateDir(dir, options);
  assertNoSymlinkComponents(file);
  if (fs.existsSync(file)) {
    const existing = fs.lstatSync(file);
    if (existing.isSymbolicLink()) {
      throw secureError('unsafe_symlink', `Refusing to replace a symbolic link at ${path.basename(file)}.`);
    }
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let fd = null;
  let renamed = false;
  try {
    fd = fs.openSync(tmp, 'wx', FILE_MODE);
    fs.writeFileSync(fd, data, encoding);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    chmodPrivate(tmp, FILE_MODE, options);
    hardenWindowsAcl(tmp, { ...options, cache: false });
    fs.renameSync(tmp, file);
    renamed = true;
    ensurePrivateFile(file, options);
    fsyncDirectory(dir, options);
    return file;
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (closeError) {
        // Ignore cleanup failure; the original error is more important.
      }
    }
    if (!renamed) {
      try {
        fs.unlinkSync(tmp);
      } catch (cleanupError) {
        // The temp file may not exist if opening it failed.
      }
    }
    throw error;
  }
}

function readFilePrivate(file, encoding = 'utf8', options = {}) {
  assertNoSymlinkComponents(file);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    throw secureError('unsafe_symlink', `Refusing to read a symbolic link at ${path.basename(file)}.`);
  }
  if (!stat.isFile()) {
    throw secureError('not_a_file', `${path.basename(file)} is not a regular file.`);
  }
  if (Number.isFinite(options.maxBytes) && stat.size > options.maxBytes) {
    throw secureError('file_too_large', `${path.basename(file)} is too large.`);
  }
  return fs.readFileSync(file, encoding);
}

function fileExists(file) {
  try {
    return fs.existsSync(file);
  } catch (error) {
    return false;
  }
}

module.exports = {
  DIR_MODE,
  FILE_MODE,
  ensurePrivateDir,
  ensurePrivateFile,
  writeFileAtomicPrivate,
  readFilePrivate,
  fileExists,
  _private: {
    hardenWindowsAcl,
    verifyWindowsAcl,
    resolveWindowsPrincipal,
    assertNoSymlinkComponents,
    chmodPrivate,
    secureError
  }
};
