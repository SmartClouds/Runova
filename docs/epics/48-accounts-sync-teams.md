# E48 Accounts, cloud sync and teams

Milestone: standalone (Account). Depends on: E41 (website API), E40W (website).

## Goal

A person signs in to Runova with an account (email and password, or Google) on each of their
computers, and their Runova data follows them: projects, environments, servers and remotes, Vault
entries, monitoring, API client collections, database connections and settings. Things that only
make sense on one computer stay there, the first being a project's folder: the same project can
live in `C:\src\shop` on Windows and `/Users/sam/shop` on a Mac, and changing one never touches the
other.

People can make a team, invite others by email, and share chosen items with it (a server list, a
password, a project's environments, a monitor). Data can be encrypted end to end with a key only
the person (or the team) knows. Secrets never leave a computer without that key.

Sessions and activity can be seen and ended both in the app (the Account page) and in the account
panel on runovahq.com, which looks like the app.

Choices the user made:

- Secrets (Vault entries, server passwords and keys, environment values, tokens) sync only once an
  encryption key is set for the account or team they belong to. Everything else syncs without one.
- A team's key is a passphrase an Owner or Admin sets and gives to members, who type it once on
  each computer.
- When the same item changed on two computers before they synced, Runova asks which one to keep.

## Design

- **Server.** The website API (`apps/website/api`) hosts accounts, sessions, activity, sync and
  teams. Accounts are rows in the same Identity user table as staff; staff are the users with the
  Admin or Editor role, and only they pass the `Staff` policy. New endpoints are listed in
  [the contract](../website/api-contract.md) in the commit that builds them.
- **Sign-in on the desktop.** The app opens the browser at `/account/authorize` with PKCE (S256), a
  random state and a loopback redirect on `127.0.0.1` (the flow of `main/oauth/loopback.ts`). The
  person signs in on the site (password, two-factor, or Google) and approves the computer. The app
  trades the one-time code for a 15-minute access token (sealed with Data Protection, no JWT) and a
  refresh token that rotates on every use. A refresh token used twice ends the whole session. The
  app never sees the password.
- **Sessions.** Every browser and every computer is a row in `AccountSessions`, checked on each
  request, so ending one works at once. Both the app and the site list them with device, platform,
  place (IP), first and last seen, and can end one or all others.
- **Activity.** Sign-ins, failed sign-ins, new devices, password, email, two-factor and key changes,
  team changes and resets go to `AccountActivities`, saved in the same transaction as the change.
- **Step-up.** Deleting the account, ending all other sessions, resetting an encryption key,
  removing a member, changing a role and deleting a team need the password (or a two-factor code
  for an account without one).
- **Sync store.** One personal scope per account and one scope per team. Each record is
  `(scope, collection, item id)` with a revision from the scope's counter, a deleted flag, the
  encryption it uses and an opaque payload. Pushes carry the revision they were based on; a stale
  one comes back as a conflict with the server's copy, and the app asks the person.
- **End-to-end encryption.** A scope's data key is 32 random bytes. The passphrase gives a key with
  scrypt that wraps it (AES-256-GCM), and so does a recovery key shown once. The server keeps only
  the wrapped copies. Records are AES-256-GCM with the scope, collection, item id and key version as
  authenticated data. The unwrapped key stays on the computer, sealed with the OS keychain
  (`safeStorage`). The browser never asks for it and never sees decrypted data.
- **What is encrypted.** With a key: secret fields always; and, by the person's choice, server
  connections, environment data, or everything. Without a key, secret fields stay on the computer
  and the app says so.
- **Sync engine.** Pure parts (hashing, diffs, field split, conflicts) in `packages/core/src/sync`;
  the engine in `apps/desktop/src/main/sync` with a SQLite state file and one adapter per collection
  that reads and writes through the existing services. Per-device fields never leave the computer.
- **Teams.** Owner, Admin, Member and Viewer. Invitations go to an email address and can only be
  accepted by an account with that address verified. Viewers read and never push. Removing a member
  takes their access away at once, and the app suggests rotating the team key.

## Tasks

- [x] E48.1 Epic doc, roadmap row and status row.
- [x] E48.2 API: policies split, registration, email verification, password reset, email outbox,
  sign-in rate limits.
- [x] E48.3 API: Google sign-in and safe linking.
- [x] E48.4 API: account sessions, ending them, activity, step-up, the new sign-in email.
- [x] E48.5 API: desktop authorization (code and PKCE), device tokens, refresh rotation, bearer scheme.
- [x] E48.6 API: sync scopes and records, changes feed, pushes with conflicts, limits, key envelopes.
- [x] E48.7 API: teams, members, roles, invitations, team scopes, team activity.
- [x] E48.8 Website: shared API helper, account guard, account layout, sign-in, register, verify,
  reset and authorize pages.
- [x] E48.9 Website: overview, profile, security, sessions, activity, delete account.
- [x] E48.10 Website: teams and invitations, sync overview, encryption status.
- [x] E48.11 Desktop: account client, browser sign-in, token store, IPC and preload.
- [x] E48.12 Desktop: key ring (wrap and unwrap, recovery key, sealing on the computer).
- [x] E48.13 Desktop: sync engine.
- [x] E48.14 Desktop: adapters for every collection, per-device fields, deletes.
- [x] E48.15 Desktop UI: Account page, signed-out state, devices, activity, nav entry, status bar.
- [x] E48.16 Desktop UI: sync settings, encryption, conflicts, "choose folder" for a synced project.
- [x] E48.17 Desktop UI: teams, team key, share to team, badges and filters.
- [x] E48.18 End-to-end tests, security review, docs.

## Acceptance criteria

- AC1 A project made on one computer appears on another signed in to the same account, without a
  folder; choosing a folder on the second computer leaves the first one's folder as it was.
- AC2 With no key set, no secret (Vault entry, password, private key, environment value, token)
  reaches the server. With a key set, the server's copy of a secret is ciphertext only.
- AC3 A second computer reads encrypted data only after the passphrase (or recovery key) is typed
  there; a wrong one is refused and changes nothing.
- AC4 Ending a session in the app or on the site signs that browser or computer out at its next
  request; a refresh token used twice ends its session.
- AC5 A team member sees the items shared with the team after typing the team key; a Viewer can not
  change them; a removed member stops getting them at once.
- AC6 An edit of the same item on two computers before they sync shows both versions and keeps the
  one the person picks.
- AC7 Google sign-in never links to an existing account by email alone.

## Implementation notes

- **Server.** Accounts, sessions, activity, device tokens, sync and teams live in
  `apps/website/api/src/Runova.Website.Api/Accounts/`. The default and fallback policies are
  Staff, so any route that forgets a policy stays closed to accounts. A device token carries no
  role and reaches account routes only. A sign-in writes its session and activity through a
  context of its own, so two sign-ins of one account at the same moment never fail each other.
- **Desktop.** `main/account/` holds the browser sign-in (`client.ts`, over the loopback listener
  of `oauth/loopback.ts`), the sealed account file (`state.ts`), the key ring (`keyring.ts`:
  scrypt at the Vault's cost, AES-256-GCM, recovery keys in Crockford base32) and the key
  service. `main/sync/` holds the engine, its SQLite state, the wire format and one adapter per
  store (`adapters/`). Secrets sealed on one computer are opened in memory for the sync and
  sealed again on the other (`adapters/envelopes.ts`).
- **Teams on items.** Which team an item is shared with is kept by the sync layer
  (`sync/teamMap.ts`, in sync-state.db), not on the stored record, because the stores' own save
  paths rebuild records and would drop it at the first edit.
- **Items that stop travelling** (an API collection grown past 700 KB, a database connection
  switched to a local file) are listed as local only, so the other computers do not read them
  as deleted.
- **Key rotation.** A new key bumps the scope's key version; the computer that rotated marks every
  item of the scope as changed, so the next push seals them all again on their own revisions.
- **Epochs.** Wiping the cloud copy or resetting a lost key starts a new epoch on the scope, and
  each computer then forgets what it knew of it and sends what it holds again.
- **Website panel.** `apps/website/web/src/pages/account/`, with the app's Dark surfaces under
  `.app-surface` (design.md, Account panel). The panel never sees decrypted data and never asks
  for a key.
- Built test-first: API integration tests against PostgreSQL in Docker, Vitest for core, main and
  renderer, Testing Library for the panel, the website e2e (fake API and the real admin stack), and
  `e2e/accountSync.e2e.ts` with two app instances on `e2e/fakeAccountServer.ts`.

- **Security review** (before merging): signing up with an address an Admin had just invited as
  staff could reset that account's password, so sign-up now leaves any user with a role alone and
  their invitation keeps working. The Google `returnUrl` refuses backslashes and control
  characters, and a synced change of an SSH server's host or port drops its host key pin, as an
  edit on the computer does.

## Known limits

- Role changes, removing a member and deleting a team need the password, so in the app they open
  the team's page on runovahq.com. Inviting, accepting, leaving, sharing and the team key are in
  the app.
- Monitoring history (samples and incidents) does not sync yet; monitors do.
- A computer offline for more than 90 days misses deletes made meanwhile (tombstones are purged).
- Sharing is in the Teams tab (Share something). The item menus of each screen do not have their
  own Share entry yet.
- Settings has no Account tab of its own; the Account page is pinned in the main menu.

## Needs from the owner

- A Google OAuth web client (id and secret) for runovahq.com, and a SendGrid API key (Mail Send
  only) with `no-reply@runovahq.com` or the runovahq.com domain verified in SendGrid, in the
  production environment (`Authentication__Google__*`, `SENDGRID_API_KEY`). Tests and development
  use fakes.
