# Correctness and Failure-Handling Audit

Audit target: `rafiebazine/Whatsapp-automation` at commit `995acf9` (baseline 129/129 tests, 29 security tests, `npm audit` clean).

Scope: correctness of the security implementation, specifically whether failures are reported and whether in-memory state, disk state, and user-visible state stay consistent. This audit does not replace the Phase 2 threat model or a professional security review.

## Findings and status

| ID | Finding | Severity | Status |
| --- | --- | --- | --- |
| SEC-01 | Auth-state write failures were logged and swallowed; the app could continue with non-durable credentials. | High | Fixed |
| SEC-02 | `Database.save()` returned normally after write failures; callers could not detect lost mutations. | High | Fixed |
| SEC-02b | Queue execution could send a WhatsApp action after its in-memory progress failed to persist. | High | Fixed |
| SEC-02c | Vault `create()` could leave a file-on-disk/empty-memory split on write failure. | High | Fixed |
| SEC-02d | Vault lockout/password/recovery writes were not rolled back on failure. | High | Fixed |
| SEC-03 | Windows ACL hardening was best-effort and unverified; inherited or failed ACLs were accepted. | High | Fixed in code; native Windows runtime remains unverified |
| SEC-03b | Atomic-write temporary files could remain after a rename failure. | Medium | Fixed |
| SEC-04 | Release artifacts were unsigned with no CI enforcement. | High | Signing/CI implemented; no certificates are configured in this environment |
| SEC-05 | No CI verified Linux and Windows tests or release signatures. | Medium | Fixed |
| SEC-06 | `Database.load()` could replace an unreadable database after a non-corruption read error. | High | Fixed: fail closed and preserve the file |
| SEC-07 | Legacy migration had no in-memory or session re-encryption rollback. | High | Fixed |
| SEC-08 | IPC binary payloads bypassed the JSON-only size check. | Medium | Fixed |
| SEC-09 | XLSX preflight did not validate local headers or per-entry ZIP64 sentinels. | Medium | Fixed |
| SEC-10 | Sensitive symlinks were followed by file helpers. | High | Fixed: component-wise symlink/root checks |
| SEC-11 | Windows ACL verification used substring principal matching and could accept inherited/unexpected entries. | High | Fixed: strict `icacls` parsing and exact principal set; native Windows CI still pending |
| SEC-12 | Temp files could receive ACLs after payload bytes were written. | High | Fixed: temp ACL/chmod before write with `onTempReady` regression test |
| SEC-13 | Post-rename verification or directory-fsync failures could report failure after committing new bytes. | High | Fixed: previous content restored and real fsync errors reported |
| SEC-14 | Interrupted or ambiguous WhatsApp actions could be requeued and sent twice. | High | Fixed: `uncertain`/`needs-review`, pre-send durable marker, no auto-retry |
| SEC-15 | Existing encrypted auth state with missing `creds`/`keys` was silently replaced. | High | Fixed: fails closed as `auth_corrupt` |
| SEC-16 | Failed encrypted migration could leave in-memory plaintext mode over encrypted on-disk data. | High | Fixed: database is locked and rollback failures are reported/relink-marked |

## Behavioral changes

- Persistence failures now throw stable errors: `db_persist_failed`, `vault_persist_failed`, and `auth_persist_failed`. IPC maps them to a generic retry message instead of exposing local paths or secrets.
- Database writes have `saveOrThrow()`, `saveBestEffort()`, and synchronous `transaction()`. Transactions restore in-memory state and rebuild the contact index on failure.
- Queue execution persists an `uncertain` target before sending. If that write fails, no WhatsApp action is sent and the queue pauses. Missing confirmation, ambiguous transport errors, interrupted work, and post-send persistence failures remain `uncertain`; jobs with uncertain work become `needs-review` and are never auto-retried. Manual verification requires a fresh group refresh and never resends.
- Auth-state writes are serialized. Each caller receives a rejecting promise on failure, transient file errors are retried three times, and a terminal credential-write failure marks the account `needsRelink` and closes the socket. Database-only identity save failures are reported separately and no longer force a relink.
- Vault create/change/reset/regenerate and password/recovery lockout writes use copy-on-write state and roll back memory on failure. A lockout that cannot be persisted fails closed.
- Windows ACL hardening fails closed if `icacls` fails, inherited entries remain, full control cannot be verified, or an unexpected principal appears. Native Windows runtime verification still requires the Windows CI job and a real Windows smoke check.
- Account add/remove/relink, settings changes, group deletion, contact import, and job creation use transactions. Removal moves session folders to tombstones before the database write; failures restore the folder, and stale tombstones are cleaned on boot.
- `Database.load()` no longer creates a replacement database after an unreadable-file error. Corrupt plaintext data is preserved with a `.corrupt-*` backup and the load throws `db_corrupt`.
- Legacy migration restores the database snapshot and re-encrypts already-migrated session folders back to the old key when the encrypted database cannot be written and verified. Once migration is verified, later backup failures do not roll back the live encrypted database.
- XLSX preflight rejects ZIP64 sentinels, mismatched local/central sizes, corrupt local headers, entries extending beyond the file, unsafe paths, encryption, and excessive ratios before SheetJS parsing.
- TOTP is not used. Recovery remains password key-wrap plus a one-time recovery key.

## Verification evidence

```text
npm test
# tests 168, pass 168, fail 0, skipped 0

npm run test:security
# tests 68, pass 68, fail 0, skipped 0

npm audit --audit-level=high
# found 0 vulnerabilities

for f in electron/*.js src/app.js src/shared/*.js scripts/*.js test/*.js; do node --check "$f"; done
# syntax ok
```

New regression suites:

- `test/security-persistence.test.js`: write/encrypt/serialize/disk-full injection, rollback, auth-state corruption rejection and previous-file preservation, start-account failure handling, queue pre-send abort, uncertain recovery, ambiguous errors, post-send persistence failure, manual verification, and duplicate-send prevention.
- `test/security-windows-acl.test.js`: strict ACL parsing, exact-principal matching, inherited/unexpected-entry rejection, temp ACL-before-write, and native Windows ACL/auth migration tests; native checks run only in the Windows job.
- `test/security-signing.test.js`: unsigned/unverified artifact reporting, valid Authenticode handling, AppImage status, and certificate-value non-disclosure.
- Expanded `test/security-fs.test.js`: temp cleanup after rename failure, symlink rejection, permission failure propagation.
- Expanded `test/security-legacy-migration.test.js`: database and session re-encryption rollback.
- `test/migration.test.js`: unreadable plaintext database is preserved and load fails closed.

Build verification (Linux):

```text
npm run build:linux
npm run checksums
npx @electron/fuses read --app dist/linux-unpacked/whatsapp-group-manager
npx asar list dist/linux-unpacked/resources/app.asar
```

- AppImage: `dist/WhatsApp Group Manager-1.0.0-x86_64.AppImage`
- SHA-256: `94c7e7bde3091df46b07c3dfb82969ba68182cb6e0af199a91a90b3aa4770cb1`
- Fuses: `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` enabled; `RunAsNode`, Node options/inspect, V8 snapshot, and file-protocol extra privileges disabled.
- ASAR contains `electron/main.js`, `electron/db.js`, `electron/vault.js`, `electron/secure-fs.js`, and `src/index.html`.
- `node scripts/verify-artifacts.js` reports the Linux AppImage as unsigned (no Authenticode equivalent) and any Windows executable as unverified on non-Windows.

## Residual risks and required operator actions

- No native Windows installer, ACL, runtime, or SmartScreen test was run here. The Windows CI job now includes tests, security tests, build, and artifact verification, but it must pass after the user pushes, and ACL enforcement still needs a real Windows smoke test.
- No code-signing certificate or protected CI secret exists in this repository snapshot. Tagged releases require `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`; without them the release workflow refuses a tagged unsigned build. Manual development builds may be unsigned and must not be represented as release-signed.
- Post-send persistence failure cannot undo the external WhatsApp action. The queue writes `uncertain` before sending and never auto-retries it; on restart the database contains `uncertain`, not `pending`. Operators must verify group membership after a disk failure.
- Real QR linking, sends, removals, and relinks were not exercised without user accounts.
- The local vault cannot protect against a compromised OS, an unlocked workstation, or an attacker who knows the password and can read the data folder.
- Losing both the password and recovery key makes the encrypted database and session state unrecoverable.
