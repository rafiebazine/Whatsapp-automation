# WhatsApp Group Manager — Technical Specification

*Handoff spec — desktop app (Electron + Node.js + Baileys), built from the original project overview plus resolved gaps*

## 0. Project Summary & Tech Stack

- Desktop-only app, packaged as a Windows .exe.
- Electron wraps a Node.js backend and a web-based UI (HTML/CSS/JS, or a bundled framework) into one process. Main process handles Baileys sessions, the job queue, and the local database; the renderer process is the UI, communicating via Electron IPC (no HTTP server — this is a single local app, not client+server).
- WhatsApp connectivity: Baileys (unofficial WhatsApp Web multi-device library).
- Local storage: a local database (SQLite via better-sqlite3 recommended, or lowdb/electron-store for a lighter footprint) holding accounts, groups, members, contacts, and job history.
- Up to 4 WhatsApp accounts logged in simultaneously, each acting as group admin.
- Fully offline-capable except for WhatsApp traffic itself; no third-party server involved.

## 1. Design System (sourced from whatsapp.com and WhatsApp's published brand palette)

WhatsApp's own site and apps use a small, consistent palette and a clean, minimal, bubble-based chat aesthetic.

**Colors:**

- Dark teal (header/toolbar anchor): `#075E54`
- Mid teal/green (secondary, hover states): `#128C7E`
- Signature green (primary actions, accents, FAB buttons): `#25D366`
- Light green (legacy sent-bubble background, success states): `#DCF8C6`
- Light blue (read-receipt ticks, links): `#34B7F1`
- Warm sand/beige (page/chat background): `#ECE5DD`
- White `#FFFFFF`, dark gray/near-black (`#111B21` / `#3B4A54`) for primary text

**Style notes to follow:**

- Flat, minimal UI — flat color fills with only subtle elevation (light shadows on cards/modals, nothing heavier).
- Generously rounded corners on buttons, inputs, and list rows (roughly 8–24px depending on element).
- Circular avatars throughout — here, a colored circle with the group's first letter, bold white text centered.
- Dark teal (`#075E54`) top navigation bar with white text/icons, consistent across every page.
- Primary action buttons (Add, Confirm) in signature green (`#25D366`) with white text.
- Destructive actions (Delete, confirmed Logout) in a clear red (e.g. `#D32525`) — not part of WhatsApp's own palette, but matches the "red for destructive" convention WhatsApp itself uses.
- Simple system sans-serif font stack (Segoe UI on Windows), matching WhatsApp Desktop's own typography.
- List-based layouts (contacts, groups, members): avatar + text + trailing icon, mirroring WhatsApp's own chat list pattern.

## 2. Local Data Model

**AdminAccount** — id, user-defined alias (e.g. "Account 1"), linked phone number, Baileys auth-folder path, status (connected/disconnected/paused/banned), dailyActionCount, dailyActionLimit, lastActiveAt, connectedAt.

**Group** — id (WhatsApp group JID), name, memberCount, lastSyncedAt, which admin accounts are admins here, status flags (hasOngoingAction, hasError).

**Member** — groupId, phoneNumber, displayName (if resolvable from Contacts), joinedViaApp, addedAt.

**Contact** — phoneNumber, name, source account, lastSyncedAt.

**Job** — id, type (add / remove / delete-group), groupId, targetNumbers\[\], status (queued/running/completed/failed/partial), createdAt, startedAt, completedAt, estimatedDurationSeconds, progress (processed/total), errors\[\] (per-number failure reasons).

**JobLogEntry** (audit trail) — jobId, numberOrAction, accountUsed, result (success/failure), timestamp, errorMessage.

## 3. Account & Session Management

- Each of the 4 admin accounts gets its own Baileys multi-file auth-state folder (e.g. `/sessions/account-1/`).
- These files hold WhatsApp's signal-protocol keys — encrypt the folder at rest (e.g. a key derived from the app's login password via Node's `crypto`), since anyone with these files can impersonate the account.
- New account linking: generate a QR via Baileys, render it in Settings → Accounts, poll connection state, and on success mark the account connected and register it as admin for all existing managed groups (per the original spec).
- Confirmed: the app uses a two-step flow for every new admin account — it first joins the group (via invite), then an existing admin account promotes it to admin. Promotion alone isn't possible until the join step completes.
- Reconnection: Baileys sockets can drop — implement automatic reconnect with backoff, and reflect account status immediately (status dot: green = connected, gray = disconnected, yellow = paused, red = banned/logged out).
- If WhatsApp logs an account out remotely (unlinked from phone, or number banned), Baileys emits a logout event — catch it, mark the account "needs re-link," and surface this clearly in Settings.

## 4. Rotation & Delay Algorithm (confirmed)

Goal: spread actions across the 4 accounts, avoid bursts, stay well under informal WhatsApp automation thresholds.

- **Per-account daily cap**: start at 20 add/remove actions per account per day (80/day total across 4 accounts), configurable in Settings. Raise only gradually, after weeks of clean history.
- **Account selection per action**: round-robin among accounts that are connected, admin of the target group, and under their daily cap — prefer whichever eligible account has used the fewest actions so far today.
- **Delay between individual actions**: random 25–90 seconds between each add/remove call, even across accounts.
- **Batch pacing**: after 5 consecutive actions by the same account, force a longer pause (3–6 minutes) before reusing it, regardless of round-robin order.
- **Quiet hours**: no actions between a configurable window (e.g. 11pm–7am local time), to mimic human activity.
- **Job splitting**: a single "add 50 numbers" job becomes individual timed actions under these rules; the UI's estimated time is the sum of expected delays given the current queue.
- **Pause-on-error**: 3 consecutive failures on one account auto-pauses it for the rest of the day and reroutes its queued work to the other eligible accounts.

*(Confirmed — use these numbers as specified.)*

## 5. Job Queue & Concurrency

- All add/remove/delete-group requests enter a single persistent job queue, stored in the local DB so it survives app restarts.
- Multiple jobs can be queued concurrently (per the original spec's "2 or more status bars"). The scheduler pulls the next eligible action across all active jobs, respecting per-account caps and delays — actions from different jobs interleave by account availability, rather than running strictly one job at a time.
- Each job tracks its own progress independently in a dismissible status area, with the group's clock icon lit in the Home list while any job targeting it is active.
- If the app closes mid-job, relaunching resumes remaining actions — queued work isn't dropped, and already-completed actions aren't re-sent.

## 6. Detailed User Flow

### 6.1 Login

- Single local-operator login: username + password, stored hashed (bcrypt/argon2) in the local DB — a local-only gate, not a multi-user system (confirmed).
- No "forgot password" flow needed for a local desktop tool; document a local reset procedure instead (e.g. deleting a config file) for a lost password.

### 6.2 Home Page

- Navbar: app name (left) + gear icon (right) → Settings.
- Body: list of managed groups. Each row: circular avatar (group name's first letter, colored), group name, member count, and conditionally a clock icon (job in progress) or an alert icon (last job ended in error, or an account issue affects this group).
- "Add new group" button opens a separate Add New Group page (see 6.2b) — it isn't inline on Home.
- Tapping a row opens the Group page.

### 6.2b Add New Group Page

- A separate page (not inline on Home), opened from the "Add new group" button.
- Step 1: choose which admin account to query (if more than one is connected).
- Step 2: the page fetches that account's current WhatsApp groups via Baileys and lists them.
- The user selects one or more groups to start managing; confirming returns them to Home with the new group(s) now listed.

### 6.3 Group Page

- Navbar: back arrow + group name + "⋮" menu → dropdown: Add members / Remove members / Delete group.
- Body: live member list, synced per Section 7's freshness rules; each row shows phone number and resolved Contact name where available.
- Any active job for this group shows its status/progress here.

### 6.4 Add Members Page

- "Import from Excel" at top: accepts .xlsx/.csv with two columns, in order — number, then name. Numbers are normalized to international format before validation.
- Deduplication: numbers already pending, already in the group, or malformed are filtered out silently before being counted or sent (per spec).
- Manual add: text input + "+" button for one number at a time, same validation/dedup rules.
- Pending list: each number with an "×" to drop it from the batch.
- Bottom button: "Add (\<count>)" — disabled at 0 pending, and disabled again immediately on tap until the job is confirmed queued (no double-submit).
- On tap: numbers become a Job, the user returns to the Group page, and estimated duration plus live progress show there.

### 6.5 Remove Members Page

- Same pattern as Add. Difference: numbers not currently in the group are silently ignored — not counted, not sent, no error shown.

### 6.6 Delete Group

- Confirmation modal: warning text + an input requiring the exact group name + "Delete" (red) / "Cancel".
- **Decision (v1)**: ignored for now — the app only stops managing/tracking the group locally (removes it from the app's list); it does not remove members or attempt to dissolve the group on WhatsApp's side. Real WhatsApp-side deletion can be revisited later if needed.

### 6.7 Settings Page

- Navbar: back arrow + "Settings" + logout icon (confirmation popup before ending the local app session).
- "Contacts" row → Contacts page.
- "Accounts": list of the up to 4 linked admin accounts, each showing alias, phone number, status, today's action count vs. cap, and a logout icon (confirmation popup naming the account before unlinking).
- "Add new admin" → QR screen to link a new WhatsApp account; on success, auto-register it as admin for existing managed groups per Section 3's join-then-promote caveat.

### 6.8 Contacts Page

- List of all known contacts (name + phone number), aggregated from the connected accounts' WhatsApp contact lists. Sync on each account's login, plus a manual "refresh" action — resolves the original spec's unspecified contact source/refresh timing.

## 7. Data Freshness Rules (per the "don't operate on outdated data" requirement)

- **Group member list**: refetch from Baileys immediately before opening Add/Remove (so "already in group" checks are accurate), and again right after a job completes.
- **Groups list**: update memberCount and status icons immediately on job state changes via in-app events, not on a timer.
- **Contacts**: sync on account connect plus manual refresh, not continuous polling.
- **Live WhatsApp-side changes**: listen for Baileys' `group-participants.update` and `groups.update` events on all 4 sockets, updating the local cache in real time even for changes made outside the app.

## 8. Error Handling & UI Feedback

- Wrap every Baileys call, file import, and DB operation in try/catch; map known failure types (invalid number, not-on-WhatsApp, rate-limited, account disconnected, permission denied) to clear user-facing messages.
- Per-job status area shows queued/running/completed/failed/partial, with a per-number error list accessible for failed/partial jobs.
- Button-level rule: disable the triggering control immediately on tap, re-enable only on a success/failure response or a sane timeout. Applies to Add, Remove, Delete-group-confirm, Logout-confirm, and Add-new-admin.

## 9. Non-Functional Requirements

- try/catch around every I/O- or network-bound operation, surfaced to the user rather than only logged.
- No duplicate submissions from double-clicks (debounce + disabled state, as above).
- All 4 Baileys sessions and the job queue persist across app restarts.
- Local-only app: its only outbound traffic is to WhatsApp's own servers via Baileys.

## 10. Packaging

- Electron + electron-builder (or Electron Forge) to produce a single Windows .exe (installer or portable build).
- Main process: Baileys sessions, DB, job queue. Renderer process: UI, communicating via Electron IPC.

## 11. Resolved Decisions

1. **Delete group**: for v1, the app only stops managing/tracking the group locally — it does not remove members or dissolve the group on WhatsApp's side (see 6.6).
2. **New-admin auto-promotion**: confirmed — the two-step join-then-promote flow (see Section 3).
3. **Add-new-group flow**: confirmed — it's a separate page (see 6.2b), not inline on Home.
4. **Excel import format**: confirmed — two columns, in order: number, name.
5. **Rotation/delay numbers**: confirmed as specified in Section 4.
6. **Login**: confirmed — single local login only.
7. **Banned-account auto-detection**: out of scope — ignored for this build.
