# Security Tests and Verification

## Baseline

- Baseline commit before Phase 2: `9066fb6`
- Baseline versions: Electron `33.4.11`, electron-builder `25.1.8`, `xlsx@0.18.5`
- Baseline automated suite: 100/100 passing
- Current versions: Electron `45.4.1`, electron-builder `26.18.0`, vendored `xlsx@0.20.3`
- Current automated suite: 129/129 passing, including 29 security tests

## Automated commands and results

```bash
node --test "test/*.test.js"
# tests 129, pass 129, fail 0

node --test "test/security-*.test.js"
# tests 29, pass 29, fail 0
```

Security suites cover:

- vault creation, unlock, lockout, password policy, recovery rotation
- encrypted database round-trip, wrong-key rejection, locked-write refusal, corruption fail-closed
- legacy plaintext database migration into an encrypted envelope
- end-to-end legacy database and v1 `auth.enc` migration with encrypted backup and relink fallback
- legacy session re-encryption and account-bound AAD
- account folder traversal and account-id mismatch rejection
- preload/invoke channel parity and event coverage
- IPC schema and packaging/CSP/window configuration checks
- fresh-install plaintext-write prevention and renderer snapshot secret-exclusion checks
- XLSX ZIP bombs, CSV bounds, import row bounds, and contact-name sanitization
- private filesystem modes and atomic write behavior
- diagnostic identifier/name redaction and friendly-error identity stripping
- renderer static safety checks for dynamic code execution, QR validation, and escaping

Syntax verification:

```bash
for f in electron/*.js src/app.js src/shared/*.js scripts/*.js test/*.js; do node --check "$f" || exit 1; done
# syntax ok
```

No linter or typechecker is configured in this project. `npm test` was intentionally not used after the user rejected it; the equivalent direct Node test command above was used instead.

## Dependency verification

```bash
npm ci --allow-git=all
# added 370 packages, audited 371 packages, found 0 vulnerabilities
node node_modules/electron/install.js
npm audit
# found 0 vulnerabilities
```

Plain `npm ci` is blocked in this environment because its `allow-git`/`allow-remote` policy rejects Baileys' transitive `libsignal` git dependency. The successful command explicitly allowed git dependencies for this install. Install scripts for three packages were blocked by the environment; Electron's binary was installed by running its install script manually.

The earlier 6 moderate advisories came from vulnerable `minimatch` versions in the electron-builder toolchain. `package.json` now pins `minimatch@9.0.9` and `minimatch@10.2.6` to `11.0.1` through npm overrides; `npm audit` reports 0 vulnerabilities.

Vendored SheetJS tarball:

```text
vendor/xlsx-0.20.3.tgz
sha256:8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8
```

## Build verification

```bash
npm run dist:linux
npm run checksums
npm run signing:status
npx @electron/fuses read --app dist/linux-unpacked/whatsapp-group-manager
npx asar list dist/linux-unpacked/resources/app.asar
cd dist && sha256sum -c "WhatsApp Group Manager-1.0.0.AppImage.sha256"
```

Results:

- Linux AppImage built successfully with electron-builder `26.18.0`.
- ASAR enabled; `electron/main.js`, `electron/vault.js`, `electron/secure-fs.js`, `electron/db.js`, and `src/index.html` are inside `app.asar`.
- Fuses verified: `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments`, `LoadBrowserProcessSpecificV8Snapshot`, and `GrantFileProtocolExtraPrivileges` disabled; `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` enabled.
- `npm run signing:status` reports unsigned because no certificate variables are configured.
- Final AppImage SHA-256: `d6ff174484f03f074087ab9fdad2bffae3acb62ec58fd09e7033ff0b422a0bf6`

## Manual checks requiring operator or environment

Not performed in this environment:

- Real WhatsApp QR linking, send/remove actions, relink, and unlink without user accounts
- Windows installer, Windows ACL enforcement, Windows runtime, and SmartScreen behavior
- Interactive smoke test of setup, login, lock, recovery, import, and restart with a graphical session
- Code signing and signed-artifact verification without certificates

Recommended operator smoke tests are in `USER_GUIDE_AND_E2E_TEST_PLAN.md`, especially T01, T02, T19, and T21.

## Security posture statement

Phase 2 is defensive hardening. It reduces local data exposure, constrains the renderer/IPC boundary, hardens the packaged runtime, and bounds untrusted import input. It is not a security certification, and it cannot protect against a compromised operating system, an unlocked workstation, or loss of the password and recovery key.
