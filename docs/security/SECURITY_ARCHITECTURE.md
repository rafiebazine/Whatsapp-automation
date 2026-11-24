# Security Architecture

This document describes the Phase 2 hardening of WhatsApp Group Manager. It is an engineering description, not a certification.

## Scope and assets

Protected assets:

- WhatsApp session credentials in `sessions/<account-id>/auth.enc`
- Tracked accounts, groups, members, contacts, jobs, and settings in the local database
- The local password verifier and key-wrap material in `auth-vault.json`
- Recovery keys shown once during setup or rotation
- Diagnostic reports, logs, and migration backups

Out of scope:

- WhatsApp's own servers, protocol, and account enforcement
- Operating-system compromise, malware with the same user privileges, or physical access to an unlocked computer
- A malicious person who knows the password and has access to the unlocked data folder
- Code-signing identity and certificate storage

## Trust boundaries

1. **Renderer → main process.** The renderer is treated as untrusted. It can only call whitelisted preload channels. The main process validates the sender frame, local URL, argument count, argument types, payload size, rate, authentication state, and recent-authentication requirement before running a handler.
2. **Main process → filesystem.** All sensitive writes go through `electron/secure-fs.js`: private directories (`0700`), private files (`0600`), atomic temporary-file plus rename writes, fsync, temporary-file cleanup, target-symlink rejection, and fail-closed Windows ACL restrictions verified with `icacls`.
3. **Main process → WhatsApp.** Baileys runs only in the main process. Session credentials are decrypted in memory only while unlocked.
4. **Imported files → application.** Spreadsheet and CSV input is bounded before parsing. XLSX ZIP containers are rejected when they are encrypted, ZIP64, path-unsafe, oversized, or excessively compressed.
5. **Logs and diagnostics → operator.** Normal logs are silent and identifiers are redacted. Full names and raw identities require explicit environment opt-ins.
6. **Persistence failures → operator.** Database, vault, and auth-state writes fail closed. In-memory mutations are rolled back in transactions, queue actions persist intent before sending, and unrecoverable write failures pause background work and surface a generic retry message.

## Authentication and key hierarchy

- A random 256-bit database encryption key (DEK) protects the database and is never derived from the password.
- The local vault stores two independent AES-256-GCM key wraps of the DEK:
  - password wrap: scrypt (`N=32768`, `r=8`, `p=1`, 32-byte key) with a persisted salt and parameters
  - recovery wrap: scrypt from a normalized `WGM-...` recovery key
- The password is also verified with bcrypt (cost 12).
- Key-wrap AAD binds each wrap to its purpose. Database encryption uses AAD `wgm-db-v2`. Session auth state uses AAD `wgm-auth-v2|<accountId>`.
- The database stores a random 256-bit session master key used to encrypt Baileys auth state. It is therefore available only after the database is unlocked.
- Legacy installs that derived session keys from the password are re-encrypted once to the random session key during migration. Accounts whose auth state cannot be re-encrypted are marked `needsRelink`.

## Login, lock, and recovery lifecycle

- Setup requires a password of at least 12 characters and at most 72 UTF-8 bytes, and displays a recovery key exactly once.
- Failed password and recovery attempts are persisted with escalating lockout delays.
- Password change verifies the current password, rewrites both wraps, rotates the recovery key, and persists the new verifier.
- Recovery reset verifies the recovery key, sets a new password, and rotates the recovery key. The old recovery key stops working.
- Logout and lock clear the DEK, session master key, sockets, and queue activity from memory.
- Auto-lock defaults to 15 minutes and is configurable from 1 to 240 minutes. On lock the queue pauses, in-flight work is given up to five seconds to settle, sessions stop, keys are cleared, and the renderer returns to login.
- Sensitive operations require a recent password confirmation (10-minute window): account add/relink/remove, group add/delete, job creation, contact import, settings changes, and recovery regeneration.

## Electron process hardening

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`
- node integration in subframes and webview attachment denied
- devtools disabled in packaged builds
- navigation, redirects, new windows, and permission requests denied
- strict CSP in `src/index.html`: no inline scripts, no remote connections, no objects, no frames, no form submissions
- ASAR packaging with `@electron/fuses`: Node CLI/environment escapes disabled, ASAR integrity and ASAR-only loading enabled, file-protocol extra privileges disabled

## Account, group, and job isolation

The product is a single-operator desktop app. Contacts and group metadata are intentionally shared between the operator's accounts. Isolation means:

- An account's `authFolder` must equal its `account.id` and resolve to a direct child of the sessions root.
- Account-specific operations reject unknown account IDs.
- Group IDs and job payloads are validated and group existence is checked before use.
- The executing admin account is selected server-side by the queue, never supplied by the renderer at execution time.

## Residual risks

- No Windows runtime, ACL, installer, or code-signing verification was possible in this Linux environment.
- The packaged artifacts are unsigned.
- Real WhatsApp sends, QR linking, and relinking were not exercised without user accounts.
- The database and vault are only as strong as the operator's password and recovery-key handling.
- A post-send persistence failure cannot undo the external WhatsApp action; the queue pauses and the operator must verify group membership after a disk failure.
- CI can run Windows tests, but native ACL enforcement and Authenticode verification still require a real Windows runner and configured certificate secrets.
- Electron and SheetJS are third-party dependencies; this work reduces but does not eliminate supply-chain risk.
