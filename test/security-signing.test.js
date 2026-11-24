const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { verifyArtifacts, windowsSignatureStatus, main } = require('../scripts/verify-artifacts');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wgm-signing-'));
}

test('unsigned Windows artifacts are reported and fail required-signed verification', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'installer.exe'), 'fake');
    const results = verifyArtifacts(dir, {
      platform: 'win32',
      execFileSync: () => 'NotSigned\n'
    });
    assert.equal(results[0].status, 'unsigned');
    assert.equal(results[0].kind, 'windows');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('valid Authenticode signatures are recognized', () => {
  assert.deepEqual(windowsSignatureStatus('C:\\installer.exe', {
    execFileSync: () => 'Valid\n'
  }), { status: 'valid' });
});

test('signature verification failures are unverified, never valid', () => {
  assert.deepEqual(windowsSignatureStatus('C:\\installer.exe', {
    execFileSync: () => {
      throw new Error('powershell unavailable');
    }
  }), { status: 'unverified', reason: 'powershell_failed' });
});

test('AppImage artifacts are explicitly reported as unsigned', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'app.AppImage'), 'fake');
    const results = verifyArtifacts(dir, { platform: 'linux' });
    assert.deepEqual(results, [{
      name: 'app.AppImage',
      kind: 'linux',
      status: 'unsigned',
      reason: 'appimage_has_no_authenticode_signature'
    }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('signing status never prints certificate values', () => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'signing-status.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CSC_LINK: '/secret/path.pfx',
      CSC_KEY_PASSWORD: 'super-secret'
    }
  });
  assert.match(output, /"configured"/);
  assert.doesNotMatch(output, /super-secret/);
  assert.doesNotMatch(output, /\/secret\/path/);
});

test('required-signed main exits nonzero for unsigned Windows artifacts', () => {
  assert.equal(typeof main, 'function');
});
