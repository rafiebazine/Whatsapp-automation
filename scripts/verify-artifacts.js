const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function windowsSignatureStatus(file, options = {}) {
  const exec = options.execFileSync || execFileSync;
  const escaped = String(file).replace(/'/g, "''");
  let output;
  try {
    output = exec('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status`
    ], { encoding: 'utf8', windowsHide: true });
  } catch (error) {
    return { status: 'unverified', reason: 'powershell_failed' };
  }
  const status = String(output || '').trim();
  if (status === 'Valid') return { status: 'valid' };
  return { status: 'unsigned', reason: status || 'not_signed' };
}

function verifyArtifacts(directory, options = {}) {
  const platform = options.platform || process.platform;
  if (!fs.existsSync(directory)) return [];
  const results = [];
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    if (!fs.statSync(file).isFile()) continue;
    if (name.endsWith('.sha256') || name.endsWith('.blockmap') || name.endsWith('.yml')) continue;
    if (name.endsWith('.exe')) {
      const signature = platform === 'win32' ? windowsSignatureStatus(file, options) : { status: 'unverified', reason: 'requires_windows' };
      results.push({ name, kind: 'windows', ...signature });
    } else if (name.endsWith('.AppImage')) {
      results.push({ name, kind: 'linux', status: 'unsigned', reason: 'appimage_has_no_authenticode_signature' });
    }
  }
  return results;
}

function main(argv = process.argv.slice(2)) {
  const requireSigned = argv.includes('--require-signed');
  const results = verifyArtifacts(path.join(__dirname, '..', 'dist'), { platform: process.platform });
  const windows = results.filter((entry) => entry.kind === 'windows');
  const unsignedWindows = windows.filter((entry) => entry.status !== 'valid');
  const report = {
    requireSigned,
    windowsArtifacts: windows,
    linuxArtifacts: results.filter((entry) => entry.kind === 'linux'),
    signed: windows.length > 0 && unsignedWindows.length === 0,
    unverified: windows.some((entry) => entry.status === 'unverified')
  };
  console.log(JSON.stringify(report, null, 2));
  if (requireSigned && unsignedWindows.length > 0) {
    console.error('Release signing is required, but not every Windows artifact has a valid Authenticode signature.');
    process.exit(1);
  }
  return report;
}

if (require.main === module) main();

module.exports = { verifyArtifacts, windowsSignatureStatus, main };
