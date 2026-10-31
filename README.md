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

On first launch, create a local username and password. This login stays on the computer and is required every time the app opens.

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
npx electron-builder --linux AppImage
```

Output: `dist/WhatsApp Group Manager-1.0.0.AppImage`.

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

The app stores its database and encrypted WhatsApp sessions in Electron's user-data folder. The exact path is shown in **Settings → Local data**.

- Database: `whatsapp-group-manager.json`
- Sessions: `sessions/` — each account's Baileys auth state is stored as AES-256-GCM encrypted `auth.enc`
- The encryption key is derived from the local login password with scrypt and HKDF
- Passwords are stored as bcrypt hashes

The password cannot be recovered. Reset the login only by clearing the app data folder described below; existing encrypted sessions will become unusable and the accounts must be re-linked.

## Reset the app

1. Quit the app.
2. Open the data folder shown in Settings.
3. Delete the whole folder.

This removes the local login, encrypted sessions, tracked groups, contacts, and job history. It does **not** unlink accounts from WhatsApp unless you unlink them in the app first. If you only delete `whatsapp-group-manager.json`, the old session files remain orphaned and should be removed too.

## Notes

This is an unofficial WhatsApp client built on Baileys. Automation can violate WhatsApp's terms and may lead to account restrictions. Use it responsibly and keep delays conservative.
