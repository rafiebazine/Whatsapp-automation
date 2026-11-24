# Security Changelog — Phase 2

## Correctness remediation (audit of `995acf9`)

- Auth-state persistence now rejects on failure, serializes writes, retries transient file errors, marks the account `needsRelink`, and closes the socket on terminal credential-write failure. Database-only identity failures are reported without forcing a relink.
- Database writes now expose `saveOrThrow`, `saveBestEffort`, and transactional rollback; queue execution persists intent before sending and pauses on persistence failure instead of silently continuing.
- Vault create/change/reset/regenerate and lockout writes are copy-on-write and roll back memory on failure. An unpersistable lockout fails closed.
- Windows ACL hardening is fail-closed and verified for inherited entries and full control; atomic-write temp files are cleaned after failed renames; target symlinks are rejected.
- Account, group, settings, contact-import, and job mutations use transactions and session-folder tombstones. Legacy migration rolls back the database snapshot and session re-encryption when encryption cannot be saved and verified.
- `Database.load()` fails closed on unreadable plaintext data and preserves a `.corrupt-*` copy instead of replacing it.
- IPC binary payload limits now account for `ArrayBuffer` and typed-array bytes; XLSX preflight validates ZIP64 sentinels, local headers, size agreement, and entry bounds.
- Added Windows/Linux security CI, release signing configuration, artifact verification scripts, and required-signed tagged releases.

## Authentication and encryption

- Added `electron/vault.js` with a random database key, scrypt password and recovery key wraps, bcrypt verifier, persisted KDF parameters, and escalating lockout.
- Enforced a 12-character minimum password and 72-byte maximum instead of silent truncation.
- Added one-time recovery keys with reset and rotation. Old recovery keys stop working after rotation.
- Added password change, explicit lock, logout, recent-auth confirmation, configurable auto-lock, and an idle-lock warning.
- Replaced legacy plaintext credentials and password-derived session encryption with an encrypted database and random per-installation session key.

## Data at rest

- Added `electron/secure-fs.js` with private directories, private atomic writes, fsync, and best-effort Windows ACLs.
- Encrypted the database with AES-256-GCM and AAD `wgm-db-v2`.
- Encrypted Baileys auth state with AES-256-GCM and account-bound AAD.
- Added strict encrypted-envelope validation, a 256 MiB cap, and fail-closed behavior on encrypted corruption.
- Added encrypted migration backups and `needsRelink` handling for unmigratable sessions.
- Extracted legacy migration into `electron/legacy-migration.js` and added integration tests for encrypted envelopes, session re-encryption, encrypted backups, and relink fallback.

## Electron and IPC

- Enabled `sandbox`, `webSecurity`, context isolation, and disabled subframe node integration.
- Disabled devtools in packaged builds.
- Denied navigation, redirects, new windows, webviews, and permission requests.
- Hardened CSP and enabled ASAR, ASAR integrity, ASAR-only loading, and `@electron/fuses`.
- Added a central IPC wrapper with trusted-sender checks, per-channel schemas, size limits, rate limits, auth gates, recent-auth gates, stable error codes, and path/recovery-key redaction.
- Added a preload whitelist consistency test.

## Isolation and input handling

- Validated account session folders to prevent traversal and account mixing.
- Validated account, group, and job identifiers and kept executing-account selection in the queue.
- Pinned SheetJS `0.20.3` from the official vendored tarball.
- Added XLSX ZIP preflight for entry count, total and per-entry uncompressed size, compression ratio, unsafe paths, encryption, and ZIP64.
- Bounded sheets, rows, columns, cells, cell length, CSV rows, contact-import keys, values, and contact names.

## Logging and diagnostics

- Defaulted pino to silent with redaction paths.
- Moved diagnostics under the private data directory.
- Hashed names and identifiers by default; raw identities require explicit opt-ins.
- Removed normal-operation raw participant dumps.
- Redacted paths and recovery keys from renderer-visible errors.

## Dependencies and build

- Upgraded Electron `33.4.11` → `45.4.1` and electron-builder `25.1.8` → `26.18.0`.
- Replaced `xlsx@0.18.5` with the vendored official `xlsx@0.20.3` tarball.
- Added after-pack fuses, after-all-artifact hooks, checksum generation, a signing-status placeholder, and Linux AppImage build scripts.
- Added npm overrides pinning vulnerable build-tool `minimatch` versions to `11.0.1`; `npm audit` now reports 0 vulnerabilities.
