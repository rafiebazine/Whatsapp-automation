# WhatsApp Group Manager

Local desktop app for managing WhatsApp groups from up to four admin accounts. It adds or removes members through a paced, rotating queue instead of sending actions all at once.

## Requirements

- Node.js 18 or newer
- Windows 10/11 or a 64-bit Linux desktop for the packaged app
- WhatsApp accounts that are admins of the groups you want to manage

## Run locally

```bash
npm install
npm start
```

On first launch, create a local username and a password of at least 12 characters. The app shows a one-time recovery key; store it offline. The login and recovery key are local to this computer.

## Build the Windows installer

```bash
npm run dist
```

Output is written to `dist/`:

- `WhatsApp Group Manager Setup ...exe` — NSIS installer
- `WhatsApp Group Manager ...exe` — portable executable

`npm run pack` creates an unpacked build in `dist/` for quicker local checks. Building Windows targets from Linux may require Wine.

## Build the Linux AppImage

```bash
npm run dist:linux
npm run checksums
```

Output: `dist/WhatsApp Group Manager-1.0.0.AppImage` plus a `.sha256` sidecar. Verify it with `sha256sum -c "dist/WhatsApp Group Manager-1.0.0.AppImage.sha256"`.

Release artifacts are currently unsigned. Code-signing certificates are not configured, so Windows SmartScreen and Linux distribution warnings may appear. Compare checksums against the source you built from.

If the AppImage is launched directly from a terminal on a Linux system that blocks Electron's SUID sandbox helper, start it with `--no-sandbox` or use the generated desktop entry:

```bash
./"dist/WhatsApp Group Manager-1.0.0.AppImage" --no-sandbox
```

## Use

1. Open **Settings → Admin accounts** and add an account, then scan its QR code from WhatsApp **Linked devices**.
2. Add the groups you want to manage from the home screen. The selected account must be a group admin.
3. Open a group and choose **Add members** or **Remove members**.
4. Add numbers manually or import the first sheet of an `.xlsx`/`.csv` file with two columns: **number, name**. A header row is optional. Use international format such as `+212612345678`; up to 5,000 rows per file.
5. Review the pending list and queue the job. Progress, errors, and retries appear on the job card.

Jobs are saved and resume after a restart. Only one action runs at a time across all jobs.

## Defaults

- 20 actions per account per day
- Random delay of 25–90 seconds between actions
- Pause of 3–6 minutes after each batch of 5 actions
- Quiet hours from 23:00 to 07:00
- Retry a transient failure up to 3 attempts
- Auto-pause an account for the rest of the day after 3 consecutive failures

All of these can be changed in **Settings**. Account rotation always prefers the least-used connected admin account.

## Local data and security

The app stores its encrypted database, local security vault, and encrypted WhatsApp sessions in Electron's user-data folder. The exact path is shown in **Settings → Local data**.

- Database: `whatsapp-group-manager.json`, encrypted with AES-256-GCM under a random 256-bit key
- Vault: `auth-vault.json`, stores bcrypt password verifier and scrypt-wrapped copies of the database key for the password and recovery key
- Sessions: `sessions/<account-id>/auth.enc`, AES-256-GCM encrypted with a random per-installation session key stored inside the encrypted database
- Backups: `whatsapp-group-manager.json.migrated-*.enc` are encrypted migration backups
- Passwords are stored as bcrypt hashes; recovery keys are shown once and stored only as key-wrap material

The app auto-locks after 15 idle minutes by default (configurable from 1 to 240 minutes in Settings). Locking pauses the queue, waits briefly for in-flight work, stops WhatsApp sockets, and clears keys from memory. Use **Lock now** in Settings or quit the app to close access.

Forgot your password? Choose **Use recovery key** on the login screen. A successful reset issues a new recovery key and invalidates the old one. If both the password and recovery key are lost, the encrypted database and sessions cannot be recovered; re-link accounts after starting fresh.

## Reset the app

1. Quit the app.
2. Open the data folder shown in Settings.
3. Delete the whole folder, including `auth-vault.json`, the encrypted database, and `sessions/`.

This removes the local login, encrypted sessions, tracked groups, contacts, and job history. It does **not** unlink accounts from WhatsApp unless you unlink them in the app first. Never keep an unencrypted copy of the database or session folder in a shared location.

See `docs/security/` for the architecture, data-protection, configuration, changelog, and test evidence.

## Notes

This is an unofficial WhatsApp client built on Baileys. Automation can violate WhatsApp's terms and may lead to account restrictions. Use it responsibly and keep delays conservative.
