# Phase 2 Security Hardening — Persistent TODO

Status legend: `[ ]` pending, `[~]` in progress, `[x]` complete, `[!]` blocked/limited.

Baseline: HEAD `9066fb6`, Electron `33.4.11`, `electron-builder` `25.1.8`, `xlsx` `0.18.5`, 100/100 tests passing before Phase 2.

Scope decisions:
- Password plus one-time-displayed recovery key.
- Electron `45.4.1` and `electron-builder` `26.18.0`.
- Auto-lock locks the UI, pauses jobs, stops sessions, and clears keys.
- SheetJS `0.20.3` official tarball.
- Single-operator model with shared contacts/groups; isolate sessions and operations.

## 1. Baseline and planning

- [x] Confirm Phase 2 scope and architecture decisions.
- [x] Reinspect Electron window, IPC, auth, DB, session, queue, import, logging, and dependencies.
- [x] Create this persistent checklist.
- [x] Record baseline test/build commands and current limitations in `SECURITY_TESTS.md`.

## 2. Secure filesystem

- [x] Add `electron/secure-fs.js` with private directory creation and `0700` mode.
- [x] Add atomic private file writes with `0600` mode, fsync, rename, post-rename chmod, and temp-file cleanup.
- [x] Add fail-closed Windows ACL hardening with `icacls` grant verification; native Windows runtime remains unverified on Linux.
- [x] Apply helpers to DB, vault, session auth state, backups, and diagnostics.

## 3. Auth vault and password policy

- [x] Implement `electron/vault.js`.
- [x] Generate a random 32-byte database key.
- [x] Implement versioned AES-256-GCM key wrapping for password and recovery key.
- [x] Persist scrypt parameters for future KDF upgrades.
- [x] Persist failed-attempt and lockout state.
- [x] Enforce 12-character minimum and maximum 72 UTF-8 bytes.
- [x] Reject overlong passwords instead of silently truncating.
- [x] Add password change and recovery-key regeneration.
- [x] Add forced rotation for legacy weak passwords.
- [x] Ensure recovery keys never reach logs, errors, or snapshots.

## 4. Encrypted database

- [x] Add `wgm-encrypted-db` envelope with format/version/cipher/IV/tag/data.
- [x] Add strict envelope schema validation and AAD.
- [x] Add `Database.inspect()`, `unlock()`, `useEncryptedData()`, `lock()`, `saveOrThrow()`, `saveBestEffort()`, and `transaction()`.
- [x] Prevent writes while locked.
- [x] Fail closed on encrypted-file corruption instead of replacing data.
- [x] Store a random session master key inside the encrypted database.

## 5. Legacy migration

- [x] Verify legacy plaintext credentials before migration.
- [x] Create vault first and handle a failed follow-up DB write without losing access; roll back the in-memory snapshot and migrated sessions.
- [x] Re-encrypt legacy `auth.enc` from password-derived key to random session key.
- [x] Mark accounts `needsRelink` when legacy session migration fails.
- [x] Create an encrypted backup after successful migration.
- [x] Never leave a plaintext migration backup behind.
- [x] Add legacy migration tests.

## 6. Authentication lifecycle

- [x] Add password lockout with persisted escalating delays.
- [x] Add recovery-code reset and rotation.
- [x] Add explicit lock and logout paths that clear master keys.
- [x] Add configurable auto-lock with main-process idle tracking.
- [x] Pause queue and wait for in-flight work before stopping sessions.
- [x] Add recent-auth checks for sensitive operations.
- [x] Add renderer recovery, password-change, lock, and reauth UI.

## 7. Electron process security

- [x] Enable `sandbox: true`, `webSecurity`, and disable webview/node-in-subframes.
- [x] Disable devtools in packaged builds.
- [x] Deny navigation, redirects, window opens, and webview attachment.
- [x] Deny permission requests and permission checks.
- [x] Harden CSP (`object-src`, `base-uri`, `frame-ancestors`, `form-action`, `connect-src`, etc.).
- [x] Enable ASAR.
- [x] Add `@electron/fuses` after-pack hook.
- [x] Add SHA-256 checksum generation, artifact verification, and release signing/CI configuration.
- [x] Document unsigned artifacts and code-signing limitations.

## 8. IPC trust boundary

- [x] Add central per-channel schema validation.
- [x] Validate trusted sender, main frame, and expected local URL.
- [x] Add payload-size and collection bounds.
- [x] Add per-channel rate limits.
- [x] Add authenticated-only and reauth-required policies.
- [x] Validate account/group IDs and server-side authorization.
- [x] Map errors to stable safe messages and codes.
- [x] Keep preload channel whitelist in sync and test it.
- [x] Add IPC security tests.

## 9. Account/group/job isolation

- [x] Validate `account.authFolder` and prevent path traversal.
- [x] Enforce resolved session paths remain under the sessions root.
- [x] Validate account existence for account-specific operations.
- [x] Validate group IDs and group existence.
- [x] Keep executing account selection server-side.
- [x] Document shared contacts/groups as the intentional single-operator exception.
- [x] Add isolation tests.

## 10. Import hardening

- [x] Remove `xlsx@0.18.5` and pin SheetJS `0.20.3`.
- [x] Verify lockfile integrity for the tarball.
- [x] Add ZIP preflight: entry count, uncompressed size, ratio, ZIP64 sentinels, unsafe paths, and local/central header agreement.
- [x] Limit sheet count, rows, columns, cells, and cell length.
- [x] Add CSV bounds and null/control-character handling.
- [x] Limit `contacts:import` row count, keys, and string lengths.
- [x] Harden contact-name sanitization.
- [x] Document that CSV formula injection is not applicable because there is no export.
- [x] Add import-hardening tests.

## 11. Logging and diagnostics

- [x] Remove raw participant dumps from normal operation.
- [x] Require explicit unsafe diagnostic opt-in for raw identities.
- [x] Move diagnostics under private data directory with `0600`.
- [x] Redact names and identifiers by default.
- [x] Configure pino redaction and keep default level silent.
- [x] Redact error logs and prevent path/secret leakage to renderer.
- [x] Add logging/redaction tests.

## 12. Renderer safety

- [x] Audit `innerHTML` calls and preserve escaping.
- [x] Validate QR image data URLs before insertion.
- [x] Add recovery-key confirmation UI.
- [x] Add recovery reset UI.
- [x] Add lock button and inactivity notice.
- [x] Add reauth prompt and retry.
- [x] Add password-change UI.
- [x] Harden data-dir and error display.
- [x] Add renderer safety checks/tests where practical.

## 13. Dependencies and build

- [x] Upgrade Electron to `45.4.1`.
- [x] Upgrade `electron-builder` to `26.18.0`.
- [x] Add `@electron/fuses`.
- [x] Rebuild `package-lock.json`.
- [x] Run `npm ci` using `--allow-git=all` because the environment blocks transitive git dependencies by default.
- [x] Re-run `npm audit`.
- [x] Add `build:linux`, `checksums`, `verify:artifacts`, `release:verify`, after-pack scripts, and Windows/Linux CI.
- [x] Verify ASAR and fuse settings.
- [x] Build Linux AppImage and generate checksums.

## 14. Tests

- [x] Add vault tests.
- [x] Add DB encryption and corruption tests.
- [x] Add auth policy and lockout tests.
- [x] Add IPC validation tests.
- [x] Add import bomb/bounds tests.
- [x] Add filesystem permission tests.
- [x] Add account-isolation tests.
- [x] Add logging redaction tests.
- [x] Add config/CSP checks.
- [x] Update existing tests.
- [x] Run full suite and record results.
- [x] Add persistence-failure, transactional rollback, Windows ACL fail-closed, signing, and migration rollback tests.

## 15. Regression and limitations

- [!] Smoke-test setup, login, lock, recovery, import, and restart (requires interactive desktop/user validation).
- [x] Add automated legacy DB and `auth.enc` migration integration tests using a realistic legacy fixture.
- [!] Smoke-test migration against a real user legacy data folder.
- [!] Smoke-test real WhatsApp QR link, send/remove, relink, and unlink with user accounts.
- [!] Verify Windows installer, native ACL enforcement, runtime, and SmartScreen behavior on Windows; CI covers tests only.
- [!] Configure code-signing certificates in protected CI secrets and verify tagged signed artifacts; the release workflow fails closed without them.
- [x] Resolved the 6 moderate dev-tool `npm audit` advisories with `minimatch` overrides; audit is clean.
- [x] Confirm no plaintext DB is written by the app path.
- [x] Confirm no secrets in renderer snapshots.
- [x] Document that real WhatsApp sends/relinks were not exercised without user accounts.
- [x] Document Windows ACL/runtime and signing limitations.
- [x] Explicitly state Phase 2 is hardening, not security certification.

## 16. Documentation

- [x] Create `docs/security/SECURITY_ARCHITECTURE.md`.
- [x] Create `docs/security/DATA_PROTECTION.md`.
- [x] Create `docs/security/SECURITY_CONFIGURATION.md`.
- [x] Create `docs/security/SECURITY_CHANGELOG.md`.
- [x] Create `docs/security/SECURITY_TESTS.md`.
- [x] Update `README.md`.
- [x] Update `USER_GUIDE_AND_E2E_TEST_PLAN.md`.
- [x] Write final Phase 2 report with residual risks and verification evidence.
- [x] Write `CORRECTNESS_REPORT.md` for the `995acf9` audit with per-finding status and evidence.

## 17. Correctness remediation (audit of `995acf9`)

- [x] Make auth-state persistence reject and preserve the previous file.
- [x] Serialize auth-state writes and retry transient file errors.
- [x] Mark accounts `needsRelink` and close sockets on terminal credential-write failure.
- [x] Separate database identity-save failures from auth-state failures.
- [x] Add `Database.saveOrThrow()`, `saveBestEffort()`, `transaction()`, and persistence reporting.
- [x] Persist queue `running` state before sending; abort the send if it fails.
- [x] Roll back job creation, account add/remove/relink, settings, group deletion, and contact import on persistence failure.
- [x] Make vault create/change/reset/regenerate/lockout copy-on-write and transactional.
- [x] Make Windows ACL failures fatal and verify inherited entries/full control.
- [x] Remove temp files after failed atomic renames and reject target symlinks.
- [x] Make unreadable plaintext database loads fail closed without replacing the file.
- [x] Roll back legacy database and session re-encryption on failed migration.
- [x] Count binary IPC payloads against the 16 MiB limit.
- [x] Validate ZIP64 sentinels, local headers, and entry bounds in XLSX preflight.
- [x] Add Windows/Linux security CI, release signing configuration, and required-signed tagged releases.
- [x] Add behavioral tests for SEC-01/02/03 and migration/queue/ACL/signing regressions.
- [x] Run the full suite, security suite, audit, syntax check, Linux build, fuses, ASAR, and checksum verification.
