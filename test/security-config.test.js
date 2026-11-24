const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('packaging enables ASAR, hardening hooks, and the Linux AppImage target', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.build.asar, true);
  assert.equal(pkg.scripts['build:linux'], 'electron-builder --linux AppImage');
  assert.equal(pkg.build.afterPack, 'scripts/after-pack.js');
  assert.equal(pkg.build.afterAllArtifactBuild, 'scripts/after-all-artifact-build.js');
  assert.ok(pkg.build.linux.target.some((entry) => entry.target === 'AppImage'));
  assert.equal(pkg.devDependencies.electron, '45.4.1');
  assert.equal(pkg.devDependencies['electron-builder'], '26.18.0');
  assert.equal(pkg.dependencies.xlsx, 'file:vendor/xlsx-0.20.3.tgz');
});

test('renderer CSP denies inline scripts, remote connections, frames, and objects', () => {
  const html = read('src/index.html');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, 'CSP meta tag is missing');
  const policy = csp[1];
  for (const directive of [
    "default-src 'none'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "connect-src 'none'"
  ]) {
    assert.ok(policy.includes(directive), `missing ${directive}`);
  }
  assert.ok(!policy.includes("script-src 'unsafe-inline'"));
});

test('fresh installs remain locked instead of writing a plaintext database', () => {
  const main = read('electron/main.js');
  const boot = main.slice(main.indexOf('async function boot()'), main.indexOf('const singleInstance'));
  const missingBranch = boot.indexOf("info.kind === 'missing'");
  const legacyLoad = boot.indexOf('db.load();');
  assert.ok(missingBranch >= 0);
  assert.ok(legacyLoad > missingBranch);
  assert.match(boot, /if \(!info \|\| info\.kind === 'missing'\) \{[\s\S]*databaseState = 'locked';/);
});

test('renderer snapshot does not expose vault material or encryption keys', () => {
  const main = read('electron/main.js');
  const block = main.slice(main.indexOf('function snapshot()'), main.indexOf('function ipcError'));
  for (const secret of ['passwordHash', 'passwordWrap', 'recoveryWrap', 'recoveryCode', 'encryptionKey', 'sessionMasterKey', 'vault.state']) {
    assert.ok(!block.includes(secret), `snapshot exposes ${secret}`);
  }
});

test('browser window enforces sandbox and packaged-only devtools', () => {
  const main = read('electron/main.js');
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /webSecurity:\s*true/);
  assert.match(main, /nodeIntegrationInSubFrames:\s*false/);
  assert.match(main, /devTools:\s*!app\.isPackaged/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /will-attach-webview/);
});
