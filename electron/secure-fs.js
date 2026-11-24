const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const WINDOWS_SYSTEM_SID = '*S-1-5-18';
const WINDOWS_ADMINISTRATORS_SID = '*S-1-5-32-544';
const WINDOWS_SYSTEM_ALIASES = ['S-1-5-18', WINDOWS_SYSTEM_SID, 'NT AUTHORITY\\SYSTEM', 'SYSTEM'];
const WINDOWS_ADMINISTRATOR_ALIASES = [
  'S-1-5-32-544',
  WINDOWS_ADMINISTRATORS_SID,
  'BUILTIN\\Administrators',
  'Administrators'
];
const WINDOWS_FORBIDDEN_PRINCIPALS = [
  'everyone',
  'nt authority\\everyone',
  'builtin\\users',
  'users',
  'nt authority\\authenticated users',
  'authenticated users'
];

function secureError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function platformOf(options = {}) {
  return options.platform || process.platform;
}

function envOf(options = {}) {
  return options.env || process.env;
}

function normalizePrincipal(value) {
  return String(value || '').trim().replace(/^\*/, '').toLowerCase();
}

function resolveWindowsIdentity(options = {}) {
  if (options.identity) return options.identity;
  const env = envOf(options);
  const aliases = new Set();
  let principal = '';
  let sid = '';
  let account = '';

  if (options.principal) {
    principal = String(options.principal).trim();
  } else {
    const exec = options.execFileSync || execFileSync;
    try {
      const output = exec('whoami', ['/user', '/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        windowsHide: true
      });
      const text = String(output || '');
      const sidMatch = text.match(/"(S-[0-9-]+)"/);
      if (sidMatch) sid = sidMatch[1];
      const accountMatch = text.match(/^\s*"([^"]+)"/);
      if (accountMatch) account = accountMatch[1];
    } catch (error) {
      // Fall back to the environment-derived account name below.
    }
    principal = account || (sid ? `*${sid}` : '');
  }

  const userName = options.userName || env.USERNAME || (os.userInfo && os.userInfo().username) || '';
  const domain = options.domain || env.USERDOMAIN || '';
  if (principal.startsWith('*S-')) sid = principal.replace(/^\*/, '');
  account = account || (principal && !principal.startsWith('*S-') ? principal : '');

  if (!principal && userName) {
    principal = domain ? `${domain}\\${userName}` : String(userName);
  }
  if (!principal) {
    throw secureError('acl_identity_unavailable', 'Could not determine the current Windows user for ACL hardening.');
  }

  for (const value of [principal, sid, account, userName, domain && userName ? `${domain}\\${userName}` : '']) {
    if (!value) continue;
    aliases.add(value);
    aliases.add(String(value).replace(/^\*/, ''));
  }

  return { principal, sid, account, userName, domain, aliases: Array.from(aliases) };
}

function resolveWindowsPrincipal(options = {}) {
  return resolveWindowsIdentity(options).principal;
}

function allowedWindowsPrincipals(identity, options = {}) {
  const env = envOf(options);
  const userName = identity.userName || env.USERNAME || (os.userInfo && os.userInfo().username) || '';
  const domain = identity.domain || env.USERDOMAIN || '';
  const values = [
    ...(identity.aliases || []),
    identity.principal,
    identity.sid,
    identity.account,
    userName,
    domain && userName ? `${domain}\\${userName}` : '',
    ...WINDOWS_SYSTEM_ALIASES,
    ...WINDOWS_ADMINISTRATOR_ALIASES
  ];
  return new Set(values.filter(Boolean).map(normalizePrincipal));
}

function parseWindowsAclEntries(text, target) {
  const entries = [];
  const targetText = String(target || '').toLowerCase();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^Successfully processed/i.test(line)) continue;
    const marker = line.lastIndexOf(':(');
    if (marker === -1) continue;
    const rightsText = line.slice(marker + 1);
    const rights = (rightsText.match(/\([^)]*\)/g) || [])
      .map((right) => right.slice(1, -1).trim().toUpperCase())
      .filter(Boolean);
    if (rights.length === 0) continue;
    const prefix = line.slice(0, marker).trim();
    let principal = prefix;
    if (targetText && prefix.toLowerCase().startsWith(targetText)) {
      principal = prefix.slice(String(target).length).trim();
    }
    if (!principal) continue;
    entries.push({ principal, rights, raw: line });
  }
  return entries;
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
  const entries = parseWindowsAclEntries(output, target);
  if (entries.length === 0) {
    throw secureError('acl_unverified', `Windows permissions on ${path.basename(target)} could not be verified as restrictive.`);
  }
  for (const entry of entries) {
    if (entry.rights.includes('I')) {
      throw secureError('acl_inherited', `Windows permissions on ${path.basename(target)} still contain inherited entries.`);
    }
  }
  const identity = resolveWindowsIdentity(options);
  const allowed = allowedWindowsPrincipals(identity, options);
  if (!entries.some((entry) => entry.rights.includes('F'))) {
    throw secureError('acl_unverified', `Windows permissions on ${path.basename(target)} could not be verified as restrictive.`);
  }
  for (const entry of entries) {
    if (entry.rights.some((right) => right !== 'F')) {
      throw secureError('acl_unverified', `Windows permissions on ${path.basename(target)} include rights beyond full control.`);
    }
    const normalized = normalizePrincipal(entry.principal);
    if (WINDOWS_FORBIDDEN_PRINCIPALS.includes(normalized) || !allowed.has(normalized)) {
      throw secureError('acl_unexpected_principal', `Windows permissions on ${path.basename(target)} include an unexpected principal.`);
    }
  }
  return true;
}

function hardenWindowsAcl(target, options = {}) {
  if (platformOf(options) !== 'win32') return target;
  const resolved = path.resolve(target);
  const exec = options.execFileSync || execFileSync;
  const identity = resolveWindowsIdentity(options);
  try {
    exec('icacls', [
      target,
      '/inheritance:r',
      '/grant:r',
      `${identity.principal}:F`,
      `${WINDOWS_SYSTEM_SID}:F`,
      `${WINDOWS_ADMINISTRATORS_SID}:F`
    ], { stdio: 'ignore', windowsHide: true });
  } catch (error) {
    throw secureError('acl_failed', `Could not restrict Windows permissions on ${path.basename(target)}.`, error);
  }
  verifyWindowsAcl(target, { ...options, identity });
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

function pathComponents(root, target, pathModule) {
  const current = pathModule.resolve(root);
  const resolved = pathModule.resolve(target);
  const relative = pathModule.relative(current, resolved);
  if (relative === '..' || relative.startsWith(`..${pathModule.sep}`) || pathModule.isAbsolute(relative)) return [];
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  const components = [current];
  let walked = current;
  for (const part of parts) {
    walked = pathModule.join(walked, part);
    components.push(walked);
  }
  return components;
}

function assertNoSymlinkComponents(target, options = {}) {
  const fsImpl = options.fs || fs;
  const resolved = path.resolve(target);
  const root = options.root
    ? path.resolve(options.root)
    : path.parse(resolved).root;
  const rootText = root.toLowerCase();
  const resolvedText = resolved.toLowerCase();
  const relative = path.relative(root, resolved);
  const insideRoot = !options.root || relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  if (!insideRoot || (rootText && !resolvedText.startsWith(rootText))) {
    throw secureError('unsafe_path', `Refusing to use a path outside the approved root: ${path.basename(resolved)}.`);
  }
  for (const component of pathComponents(root, resolved, path)) {
    let stat;
    try {
      stat = fsImpl.lstatSync(component);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw secureError('unsafe_symlink', `Refusing to use a symbolic link at ${path.basename(component)}.`);
    }
  }
  return resolved;
}

function ensurePrivateDir(dir, options = {}) {
  assertNoSymlinkComponents(dir, options);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(dir);
  assertNoSymlinkComponents(dir, options);
  if (!stat.isDirectory()) {
    throw secureError('not_a_directory', `${path.basename(dir)} is not a directory.`);
  }
  chmodPrivate(dir, DIR_MODE, options);
  hardenWindowsAcl(dir, options);
  return dir;
}

function ensurePrivateFile(file, options = {}) {
  const resolved = assertNoSymlinkComponents(file, options);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    throw secureError('unsafe_symlink', `Refusing to use a symbolic link at ${path.basename(resolved)}.`);
  }
  if (!stat.isFile()) {
    throw secureError('not_a_file', `${path.basename(resolved)} is not a regular file.`);
  }
  chmodPrivate(resolved, FILE_MODE, options);
  hardenWindowsAcl(resolved, options);
  return resolved;
}

function fsyncDirectory(dir, options = {}) {
  if (platformOf(options) === 'win32') return;
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!error || !['EINVAL', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
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

function restoreCommittedFile(file, data, options = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `${path.basename(file)}.${process.pid}.restore.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', FILE_MODE);
    chmodPrivate(tmp, FILE_MODE, options);
    hardenWindowsAcl(tmp, options);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    if (!options.skipDirectorySync) fsyncDirectory(dir, options);
    return file;
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (closeError) {
        // Ignore cleanup failure; the original error is more important.
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch (cleanupError) {
      // The temp file may not exist if opening it failed.
    }
    throw error;
  }
}

function writeFileAtomicPrivate(file, data, encoding = 'utf8', options = {}) {
  const dir = path.dirname(file);
  ensurePrivateDir(dir, options);
  const resolvedFile = assertNoSymlinkComponents(file, options);
  if (fs.existsSync(resolvedFile)) {
    const existing = fs.lstatSync(resolvedFile);
    if (existing.isSymbolicLink()) {
      throw secureError('unsafe_symlink', `Refusing to replace a symbolic link at ${path.basename(resolvedFile)}.`);
    }
  }
  const tmp = path.join(
    dir,
    `${path.basename(resolvedFile)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let fd = null;
  let renamed = false;
  let originalBytes = null;
  try {
    if (fs.existsSync(resolvedFile)) originalBytes = fs.readFileSync(resolvedFile);
    fd = fs.openSync(tmp, 'wx', FILE_MODE);
    assertNoSymlinkComponents(tmp, options);
    chmodPrivate(tmp, FILE_MODE, options);
    hardenWindowsAcl(tmp, options);
    if (typeof options.onTempReady === 'function') options.onTempReady(tmp);
    fs.writeFileSync(fd, data, encoding);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, resolvedFile);
    renamed = true;
    ensurePrivateFile(resolvedFile, options);
    fsyncDirectory(dir, options);
    return resolvedFile;
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (closeError) {
        // Ignore cleanup failure; the original error is more important.
      }
    }
    if (renamed) {
      try {
        if (originalBytes !== null) {
          restoreCommittedFile(resolvedFile, originalBytes, { ...options, skipDirectorySync: true });
        } else {
          fs.unlinkSync(resolvedFile);
        }
      } catch (rollbackError) {
        error.cause = error.cause ? [error.cause, rollbackError] : rollbackError;
        error.message = `${error.message} Rollback after failed commit also failed: ${rollbackError.message}`;
      }
    } else {
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
  const resolved = assertNoSymlinkComponents(file, options);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    throw secureError('unsafe_symlink', `Refusing to read a symbolic link at ${path.basename(resolved)}.`);
  }
  if (!stat.isFile()) {
    throw secureError('not_a_file', `${path.basename(resolved)} is not a regular file.`);
  }
  if (Number.isFinite(options.maxBytes) && stat.size > options.maxBytes) {
    throw secureError('file_too_large', `${path.basename(resolved)} is too large.`);
  }
  return fs.readFileSync(resolved, encoding);
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
    resolveWindowsIdentity,
    resolveWindowsPrincipal,
    parseWindowsAclEntries,
    assertNoSymlinkComponents,
    chmodPrivate,
    secureError
  }
};
