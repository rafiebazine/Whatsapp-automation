# Data Protection

## Files

| Path | Contents | Protection |
| --- | --- | --- |
| `whatsapp-group-manager.json` | Accounts, groups, members, contacts, jobs, settings, session master key | AES-256-GCM envelope `wgm-encrypted-db` v2, AAD `wgm-db-v2` |
| `auth-vault.json` | Username, bcrypt verifier, scrypt parameters, password and recovery key wraps, lockout state | Private file; wrapped DEK only |
| `sessions/<account-id>/auth.enc` | Baileys credentials and keys | AES-256-GCM, AAD `wgm-auth-v2|<accountId>`, random session key |
| `whatsapp-group-manager.json.migrated-*.enc` | Encrypted migration backup | Same database envelope |
| `diagnostics/contact-diagnostics.json` | Diagnostic report, disabled by default | Private directory and file; identifiers hashed by default |
| `logs/` | Startup and error logs, when enabled | Pino redaction, silent by default |

No plaintext password, DEK, recovery key, or session master key is written to disk. Recovery keys are displayed once and are not persisted in plaintext.

## Fresh install behavior

A fresh app start does not create a plaintext database. Until setup succeeds, the database stays in memory and the app remains locked. The first successful setup writes the encrypted envelope directly.

## Legacy migration

1. The app verifies the existing plaintext credentials before creating the vault.
2. The vault is created with the new 12-character password and a new recovery key.
3. The database is encrypted with a fresh random DEK and a fresh random session master key.
4. Legacy `auth.enc` files are re-encrypted from the password-derived key to the random session key.
5. An encrypted `.migrated-*.enc` copy is written after the new database is verified.
6. Accounts that fail re-encryption are marked `needsRelink`; the app does not silently discard them.

A failed migration leaves the plaintext database and the new vault in place so the operator can retry. There is no plaintext migration backup.

## Backup and restore

- Back up the whole data folder only while the app is closed, or copy the encrypted database and vault together.
- The vault is required to decrypt the database. Restoring `whatsapp-group-manager.json` without `auth-vault.json` makes the data unrecoverable.
- The recovery key is required if the password is lost. Store it offline, not next to an unencrypted backup.
- Migration backups are encrypted with the same protection as the live database.

## Lock, logout, and deletion

- Lock and logout clear the DEK, session master key, sockets, and queue from memory. They do not delete files.
- Deleting the data folder removes the vault, database, sessions, diagnostics, and logs. Accounts must be re-linked.
- Deleting only the database or only the vault can make remaining data unrecoverable. Delete the whole folder when intentionally resetting.

## Diagnostic opt-ins

| Variable | Effect |
| --- | --- |
| `WGM_LOG_LEVEL` | Pino level for session logs; default `silent` |
| `WGM_DIAGNOSTIC_CONTACTS=1` | Enables contact diagnostics with hashed identifiers and names |
| `WGM_DIAGNOSTIC_CONTACTS_FULL=1` | Includes unhashed names, still limits samples |
| `WGM_DIAGNOSTIC_CONTACTS_RAW_IDS=1` | Includes raw identifiers |
| `WGM_DIAGNOSTIC_PARTICIPANTS=1` | Dumps raw group participants to stdout |
| `WGM_DIAGNOSTIC_REPORT` | Overrides the diagnostic report path |

These opt-ins can expose personal data and must not be used in normal operation or attached to bug reports.
