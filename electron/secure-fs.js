const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const hardenedWindowsPaths = new Set();

function hardenWindowsAcl(target) {
  if (process.platform !== 'win32') return;
  if (hardenedWindowsPaths.has(target)) return;
  hardenedWindowsPaths.add(target);
  const user = process.env.USERNAME;
  if (!user) return;
  try {
    execFileSync('icacls', [target, '/inheritance:r', '/grant:r', `${user}:F`], {
      stdio: 'ignore',
      windowsHide: true
    });
  } catch (error) {
    // ACL hardening is best effort; file modes are still applied where supported.
  }
}

function chmodPrivate(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch (error) {
    // Windows and some filesystems do not implement POSIX modes.
  }
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodPrivate(dir, DIR_MODE);
  hardenWindowsAcl(dir);
  return dir;
}

function ensurePrivateFile(file) {
  chmodPrivate(file, FILE_MODE);
  hardenWindowsAcl(file);
  return file;
}

function fsyncDirectory(dir) {
  if (process.platform === 'win32') return;
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

function writeFileAtomicPrivate(file, data, encoding = 'utf8') {
  const dir = path.dirname(file);
  ensurePrivateDir(dir);
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', FILE_MODE);
    fs.writeFileSync(fd, data, encoding);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  chmodPrivate(tmp, FILE_MODE);
  fs.renameSync(tmp, file);
  ensurePrivateFile(file);
  fsyncDirectory(dir);
  return file;
}

function readFilePrivate(file, encoding = 'utf8') {
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
  fileExists
};
