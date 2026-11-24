# Security Configuration

## Runtime settings

| Setting | Default | Range or behavior |
| --- | --- | --- |
| Auto-lock | 15 minutes | 1–240 minutes; `0` disables in stored data but the UI rejects 0 |
| Recent-auth window | 10 minutes | Sensitive IPC operations return `reauth_required` |
| Password length | at least 12 characters | At most 72 UTF-8 bytes |
| Auth IPC rate limit | 20 requests/minute per channel | Excess returns `rate_limited` |
| Other IPC rate limit | 180 requests/minute per channel | Excess returns `rate_limited` |
| IPC argument limit | 6 arguments | Rejected before handler |
| IPC payload limit | 16 MiB | Serialized argument size |

## Import limits

| Limit | Value |
| --- | --- |
| File size | 8 MiB |
| Rows | 5,000 |
| Columns | 10 |
| Cell length | 1,000 characters |
| Sheets | 10 |
| ZIP entries | 5,000 |
| ZIP total uncompressed | 64 MiB |
| ZIP individual entry | 16 MiB |
| ZIP compression ratio | 200:1 |

CSV rows are preflighted, and contact import rows are limited to 10 keys and 1,000 characters per value. Contact names are sanitized for control characters and capped at 200 characters. CSV formula injection is not applicable because the app does not export spreadsheets.

## Electron and build

- Electron `45.4.1`, electron-builder `26.18.0`
- ASAR enabled
- Fuses configured in `scripts/after-pack.js`
- Windows targets: NSIS and portable
- Linux target: AppImage
- `npm run checksums` writes a `.sha256` sidecar for every file in `dist/`
- `npm run signing:status` reports whether certificate environment variables are configured without printing their values

Verify a packaged build:

```bash
npx @electron/fuses read --app dist/linux-unpacked/whatsapp-group-manager
sha256sum -c "dist/WhatsApp Group Manager-1.0.0.AppImage.sha256"
npx asar list dist/linux-unpacked/resources/app.asar | head
```

Expected fuses: `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments`, `LoadBrowserProcessSpecificV8Snapshot`, and `GrantFileProtocolExtraPrivileges` disabled; `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` enabled.

## Dependency overrides

`package.json` pins vulnerable build-tool `minimatch@9.0.9` and `minimatch@10.2.6` to `11.0.1`. These are development/build dependencies only and are not included in the shipped application runtime.

## Signing

No code-signing certificates are configured. Windows artifacts will be unsigned, and Linux AppImages are not GPG-signed. Distribute checksums through a trusted channel and rebuild from reviewed source when possible.

## Linux sandbox note

Development builds may require `--no-sandbox` when Electron's SUID helper is not owned by root with mode `4755`. Prefer fixing the helper permissions or using a properly installed package. The application-level Electron sandbox remains enabled in code.
