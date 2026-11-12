# WhatsApp Group Manager — User Guide and End-to-End Test Plan

## 1. What this app does

WhatsApp Group Manager is a local desktop application for managing membership in WhatsApp groups from one or more WhatsApp accounts that are admins of those groups.

It lets you:

- Link up to four WhatsApp admin accounts by scanning a QR code.
- Add WhatsApp groups you already participate in to the app.
- Add or remove group members through a paced queue.
- Import recipients from an Excel or CSV file.
- Rotate actions across connected admin accounts.
- Track job progress, skipped recipients, and errors.
- Keep WhatsApp sessions and app data on your own computer.

The app is not a WhatsApp replacement. It is an unofficial automation tool built on Baileys. Automation can violate WhatsApp's terms and may lead to account restrictions. Use conservative delays and test with non-critical groups first.

## 2. Key concepts

### Local login

The first time the app opens, you create a local username and password. This login protects the app on this computer and is used to derive the encryption key for WhatsApp session files.

- The password is not recoverable.
- Logging out of the app does not unlink WhatsApp accounts.
- Clearing the app data folder removes the local login and encrypted sessions. Linked accounts must then be linked again.

### Admin accounts

A linked WhatsApp account is only useful for a group if that account is an admin of the group.

The app can use multiple admin accounts so actions can be spread across accounts. It prefers the least-used eligible connected account and respects daily caps, delays, batch pauses, and quiet hours.

### Managed groups

A managed group is a WhatsApp group stored locally by the app. Adding a group does not create or modify the group on WhatsApp. It only starts tracking it in the app.

### Jobs

An add or remove action creates a job. A job contains a list of recipients and moves through states such as:

- `queued` — waiting to run.
- `running` — currently being processed.
- `completed` — all recipients processed successfully or skipped.
- `partial` — some recipients failed.
- `failed` — the job could not complete successfully.

Only one WhatsApp action runs at a time across all jobs. Finished jobs can be dismissed from the job card.

### WhatsApp identities and phone numbers

WhatsApp can identify a person by a phone-number JID such as `212612345678@s.whatsapp.net` or by a LID such as `123456789012345@lid`.

The app preserves the identity WhatsApp provides. A phone number is useful metadata but is not always available, especially for LID-only participants. The app must not guess a phone number from a LID, and LID-only members are still shown and can still be targeted by their JID.

### Contacts

Contacts are names and identities collected from linked accounts and groups. Contacts can be searched by name, phone number, JID, or LID.

## 3. How to run the app

### Packaged Linux AppImage

From the project folder:

```bash
./dist/"WhatsApp Group Manager-1.0.0.AppImage" --no-sandbox
```

The `--no-sandbox` flag is needed on some Linux systems because the AppImage's Chromium sandbox helper is not configured as a setuid root binary. It is acceptable for local testing. For production use, configure the Chromium sandbox properly or run the unpacked build.

If the AppImage cannot mount because FUSE is unavailable:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./dist/"WhatsApp Group Manager-1.0.0.AppImage" --no-sandbox
```

### From source

```bash
npm install
npm start
```

## 4. Normal user flow

### First launch

1. Create a local username and password.
2. Sign in.
3. Open **Settings**.
4. Under **Admin accounts**, choose **Add new admin**.
5. Enter an alias and scan the QR code from WhatsApp **Linked devices**.

### Add a group

1. On the home screen, choose **Add new group**.
2. Select a connected admin account.
3. Select one or more groups where that account is an admin.
4. Confirm. The app fetches group metadata and stores the group locally.

If the account is not an admin of a group, the group is marked **Not admin** and should not be selected for management.

### Add members

1. Open a managed group.
2. Open the group menu and choose **Add members**.
3. Add recipients manually or import a spreadsheet.
4. Review the pending list.
5. Choose **Add (count)**.
6. Watch progress on the group page or home screen.

Add jobs ignore recipients who are already members or already queued for the same action.

### Remove members

1. Open a managed group.
2. Open the group menu and choose **Remove members**.
3. Add recipients manually, by phone number or JID, or import a spreadsheet.
4. Review the pending list.
5. Choose **Remove (count)**.
6. Watch progress and review any errors.

Remove jobs only keep recipients that are currently members of the group. LID-only members can be targeted by entering their JID.

### Import a spreadsheet

The first sheet is read. Use two columns in this order:

| number | name |
| --- | --- |
| +212612345678 | Example Person |
| 123456789012345@lid | LID Member |

A header row is optional. Up to 5,000 rows are read. Duplicate and invalid recipients are ignored by the app.

### Group page

The group page shows:

- The group name and member count.
- The last sync time.
- The current member list, including members without phone numbers.
- Admin badges.
- Active and recent jobs for that group.
- A **Refresh** button to fetch current WhatsApp metadata.

### Settings

Settings contains:

- **Contacts** — view and refresh known contacts.
- **Admin accounts** — add, relink, or unlink accounts.
- **Rotation & pacing** — daily cap, batch size, delays, batch pauses, and quiet hours.
- **Local data** — shows the local data folder path.

Default pacing:

- 20 actions per account per day.
- Random delay of 25–90 seconds between actions.
- Pause of 3–6 minutes after each batch of 5 actions.
- Quiet hours from 23:00 to 07:00.
- Retry transient failures up to 3 attempts.
- Auto-pause an account for the rest of the day after 3 consecutive failures.

### Relink an account

Relinking logs the account out, deletes its old encrypted session, and asks for a new QR code. The app also removes the old identity from local group members and admin records.

### Unlink an account

Unlinking logs the account out of WhatsApp, deletes its local session, and removes it from the app's admin accounts. Groups remain tracked locally.

### Delete a managed group

Deleting a group removes it from the app only. It does not remove members or delete the WhatsApp group. You must type the exact group name to confirm.

## 5. End-to-end test plan

### 5.1 Purpose

This plan verifies the complete user workflow, job execution, persistence, error handling, and the PN/LID identity behavior.

### 5.2 Test environment

- A Linux desktop with the generated AppImage.
- A backup of any existing app data folder before testing.
- At least two WhatsApp accounts:
  - One account that is an admin of a test group.
  - Optionally a second admin account for rotation tests.
- A WhatsApp test group with:
  - At least one normal phone-number member.
  - At least one member whose identity is LID-based, if available.
  - At least one member you can safely remove and add back.
- A CSV or XLSX file with phone numbers, names, duplicates, and at least one invalid entry.

Do not use critical production groups for destructive tests.

### 5.3 Test data template

Create a CSV file named `members-test.csv`:

```csv
number,name
+212600000001,Test One
+212600000002,Test Two
+212600000002,Duplicate Test Two
invalid-number,Invalid Entry
```

For LID testing, add a row using a real LID JID from the group member list:

```csv
number,name
123456789012345@lid,LID Test Member
```

### 5.4 Test cases

#### T01 — Fresh first launch and local login

Steps:

1. Move or back up the existing app data folder.
2. Start the app with `--no-sandbox`.
3. Confirm the first-time setup screen appears.
4. Enter a username shorter than 3 characters.
5. Enter a password shorter than 6 characters.
6. Enter mismatched password confirmation.
7. Enter valid credentials and create the login.

Expected:

- Invalid values show clear validation messages.
- Valid values create the local login and open the home screen.
- The home screen shows no accounts and no groups.
- The app suggests linking the first admin account.

#### T02 — Login and logout

Steps:

1. Log out from Settings.
2. Enter an incorrect username or password.
3. Enter the correct credentials.
4. Log out again.

Expected:

- Incorrect credentials are rejected.
- Correct credentials open the app.
- Logging out returns to the login screen.
- WhatsApp accounts remain linked after app logout.

#### T03 — Link an admin account

Steps:

1. Open Settings.
2. Choose **Add new admin**.
3. Enter an alias.
4. Scan the QR code from WhatsApp **Linked devices**.
5. Wait for the account to connect.

Expected:

- The QR modal appears.
- The account status changes to connected.
- The account alias and identity are shown.
- The account can be selected when adding groups.
- The app does not expose QR payloads or session secrets in the UI.

#### T04 — Add a managed group

Steps:

1. Open **Add new group**.
2. Select the connected admin account.
3. Confirm a group where the account is an admin is selectable.
4. Confirm a group where the account is not an admin is marked **Not admin**.
5. Select an admin group and confirm.

Expected:

- Available groups are listed.
- Already-managed groups show **Managed**.
- Non-admin groups show **Not admin**.
- The selected group appears on the home screen with a member count.

#### T05 — Group member list and LID display

Steps:

1. Open the managed group.
2. Inspect the member list.
3. Confirm phone-number members show a phone number or name.
4. Confirm LID-only members are still present.
5. Confirm LID-only members show their JID when no phone number exists.
6. Confirm admin badges appear for the correct members.

Expected:

- No member is dropped because a phone number is missing.
- LID-only members remain visible.
- Admin badges match WhatsApp group admins.
- The app does not display a fabricated phone number for a LID.

#### T06 — Refresh group metadata

Steps:

1. Add or remove a member directly in WhatsApp.
2. Return to the app and open the group.
3. Choose **Refresh**.

Expected:

- The member list updates.
- Member count updates.
- Admin badges update.
- A clear error appears if no connected account can refresh the group.

#### T07 — Add members manually

Steps:

1. Open the group menu and choose **Add members**.
2. Add a valid international phone number that is not in the group.
3. Try adding the same number again.
4. Try adding a number that is already in the group.
5. Try adding an invalid value.
6. Queue the valid recipient.

Expected:

- The valid number appears once in the pending list.
- Duplicate input is rejected.
- An existing member is rejected as already in the group.
- Invalid input shows a validation message.
- The job is queued and appears with progress.

#### T08 — Add members from CSV/XLSX

Steps:

1. Open **Add members**.
2. Import `members-test.csv`.
3. Review the pending list.
4. Queue the job.

Expected:

- Valid rows are added.
- Duplicate rows are ignored.
- Invalid rows are ignored.
- Names are preserved where provided.
- The job reports the correct total.

#### T09 — Remove members by phone and JID

Steps:

1. Open the group menu and choose **Remove members**.
2. Add a phone-number member by phone.
3. Add a LID-only member by JID.
4. Try adding a non-member.
5. Queue the valid recipients.

Expected:

- Phone-number members are accepted by phone.
- LID-only members are accepted by JID.
- Non-members are rejected.
- The job targets the correct identities.
- Errors identify the recipient without exposing secrets.

#### T10 — Queue pacing and rotation

Steps:

1. Queue an add or remove job with several recipients.
2. Observe the job card and group page.
3. Confirm actions are not sent instantly.
4. Confirm the job shows remaining time and progress.
5. If multiple admin accounts are linked, observe which account is used.

Expected:

- Delays are applied between actions.
- Batch pauses are applied.
- Progress updates in the UI.
- The least-used eligible connected admin is preferred.
- Daily caps and quiet hours are respected.

#### T11 — Multiple jobs

Steps:

1. Queue a job for one group.
2. Queue another job for the same or another group.
3. Observe both job cards.

Expected:

- Multiple jobs are tracked separately.
- Only one WhatsApp action runs at a time.
- Each job shows its own progress and errors.
- Finished jobs can be dismissed.

#### T12 — Job errors and retries

Steps:

1. Create a job with a recipient that is likely to fail.
2. Wait for the result.
3. Open **View errors** on the job card.

Expected:

- The failed recipient is marked failed.
- The error modal shows the recipient, reason, and account used.
- Transient errors are retried up to the configured limit.
- Repeated failures can auto-pause the account for the day.

#### T13 — Persistence after restart

Steps:

1. Queue a job with enough recipients to remain active.
2. Close the app completely.
3. Reopen and log in.
4. Check groups, jobs, and settings.

Expected:

- Managed groups remain.
- Job history remains.
- Queued or interrupted work resumes safely.
- Previously completed statuses are not lost.
- Settings remain.

#### T14 — Settings changes

Steps:

1. Open Settings.
2. Change the daily cap, batch size, delays, batch pauses, and quiet hours.
3. Save.
4. Reopen the app and verify the values.

Expected:

- Invalid min/max combinations are rejected.
- Valid settings are saved and survive restart.
- New jobs use the updated pacing.

#### T15 — Contacts sync and search

Steps:

1. Open Settings → Contacts.
2. Refresh contacts.
3. Search by name.
4. Search by phone number.
5. Search by JID or LID where available.

Expected:

- Contacts from linked accounts appear.
- Search filters correctly.
- Contacts without phone numbers remain searchable by identity.
- No duplicate contact is created for the same identity.

#### T16 — Relink an account

Steps:

1. Note the account's groups and admin records.
2. Choose **Relink** for the account.
3. Scan the QR code with the same or another WhatsApp account.
4. Inspect group member and admin data.

Expected:

- The old session is removed.
- A new QR flow is required.
- The old identity is removed from local group member/admin records.
- The new identity is stored after linking.
- The account can still access groups where it is an admin.

#### T17 — Unlink an account

Steps:

1. Choose **Unlink** for an account and confirm.
2. Check Settings and affected groups.

Expected:

- The account is removed from the app.
- Its local session is deleted.
- It is removed from group admin account lists.
- Groups remain tracked.
- WhatsApp itself is not asked to delete groups.

#### T18 — Delete a managed group

Steps:

1. Open the group menu and choose **Delete group**.
2. Try confirming with the wrong name.
3. Confirm with the exact group name.

Expected:

- The delete button remains disabled until the exact name is entered.
- Deleting removes the group only from the app.
- Members are not removed from WhatsApp.
- The WhatsApp group is not deleted.

#### T19 — Migration from an older database

Steps:

1. Back up the current data folder.
2. Restore an older `whatsapp-group-manager.json` that contains phone-number-only members and jobs.
3. Start the app and log in.
4. Check groups, members, contacts, and jobs.

Expected:

- Existing accounts, groups, contacts, and jobs still load.
- Existing job statuses are preserved.
- Phone-number members receive a PN JID identity.
- LID members without phone numbers are preserved.
- Admin records use actual participant JIDs where possible.
- Repeated restarts do not duplicate members or contacts.

#### T20 — LID and PN identity edge cases

Steps:

1. Open a group that contains both PN and LID participants.
2. Verify the connected admin is detected correctly.
3. Refresh the group.
4. Queue a remove action for a LID-only member.
5. Queue an add action for a phone-number recipient.
6. Confirm no LID digits appear as a phone number anywhere.

Expected:

- Admin detection works for LID admin IDs and PN fallbacks.
- LID-only members are not discarded.
- LID JIDs are sent as LID JIDs.
- Phone recipients are converted to PN JIDs.
- The app never treats a LID's digits as a phone number.

### 5.5 Acceptance criteria

The release is ready for commit when:

- All test cases above pass or have documented, accepted limitations.
- No existing group, member, contact, or job is lost during migration.
- No LID is converted into a phone number.
- No participant without a phone number disappears from the member list.
- Add and remove jobs target the correct WhatsApp identity.
- Job progress, errors, persistence, and pacing behave as described.
- The app restarts cleanly and resumes saved work.
- No secrets, QR payloads, or session keys appear in logs or the UI.

### 5.6 Bug report template

When a test fails, record:

```text
Test case:
App version / build:
Operating system:
Account alias:
Group name:
Action:
Expected result:
Actual result:
Steps to reproduce:
Screenshot or log excerpt:
Does it happen after restart?
```

Do not include QR codes, passwords, session keys, or private message contents in bug reports.
