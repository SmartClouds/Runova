# E118 Several accounts on the phone

Milestone: standalone (Accounts, Mobile). Depends on: E81, E115, E117.

## Goal

The phone app holds more than one Runova account. People add a second account without signing out
of the first, switch between them in one tap from the Account tab or the Systems screen, sign out of
one or of all of them, and get push notifications from every account, each saying whose it is.

## Design

- **One account in use.** Only the active account has the hub, the notification feed and a computer
  link, so the memory budget and the "one live link" rule stay as they were. The others keep their
  tokens in the secure store and wait.
- **Per phone and per account.** The identity seed, device id, seal key, pinned computer keys,
  passcode lock, recovery phrases, intro and receive settings belong to the phone and are shared.
  Tokens, the systems list, the server's device row, the account, inbox, monitoring and encryption
  screens and the push registration belong to an account.
- **Storage.** `accounts` holds the index: the account in use and, for each account, its server id,
  email, name, an opaque push tag, when it was added and last used, the hash of the push token it
  registered, and whether its session ended. Tokens live in `tokens:{id}`. A sign-in waits in
  `tokens:pending` until the first start reads `/api/v1/accounts/me` and learns whose it is. The
  one `tokens` key of earlier versions moves to the pending slot on start, so nobody is signed out
  by the update.
- **Signing in.** Every sign-in (browser, QR, passkey, Google, Apple) runs on a second session over
  the pending slot, so the account in use stays connected until the new one has worked. Signing in
  to an account that is already on the phone replaces its tokens instead of adding it twice.
- **Switching.** The engine drops everything that belongs to the account in use, points the session
  at the other account's slot and starts it. A generation counter drops any late answer for the
  account left behind. Pointing the session waits for a refresh under way, and work on an account
  not in use takes a lock a start also takes, so one refresh token is never used by two sessions
  at once (the server ends every session when one is reused).
- **Signing out.** Signing out of one account ends its server session with its own token and
  forgets it. Signing out of the one in use moves to the most recently used other account. The
  last account going clears the phone as signing out always did. "Sign out of all accounts" ends
  every session and clears the phone; a forgotten passcode does the same.
- **A session that ended.** When the server refuses an account, it stays listed, marked to sign in
  again. The sign-in screen says whose session ended and offers the other accounts.
- **Push for every account.** The website keeps one push row per account and token instead of one
  per token, each with the tag the phone made for that account. Tagged pushes carry `account`: on
  Android they come as data only, so the app shows them with the account's email as the subtext,
  and on iOS they are mutable so the extension sets the subtitle. Labels only show when the phone
  holds more than one account. A tap for an account not in use switches to it first.

## Tasks

- [x] T1 Website API: push rows per account and token, the account tag, tagged payloads.
- [x] T2 Rust api crate: a session's sibling, reload and switch.
- [x] T3 Rust core: the accounts index, add, switch, sign out of one or all, a session that ended,
  push for every account, a tap for another account.
- [x] T4 Android: the account header, the switcher sheet, managing accounts, adding, switching,
  the Systems avatar, tagged pushes.
- [x] T5 iOS: the same screens and tagged pushes, written to match.
- [x] T6 Docs.

## Acceptance criteria

- AC1 A second account can be added while the first stays signed in and connected, and cancelling
  leaves everything as it was.
- AC2 Switching uses the other account's tokens and starts its screens afresh, and a late answer for
  the old account changes nothing.
- AC3 Signing out of an account not in use ends its own session only. Signing out of the account in
  use moves to another. The last account, or "all accounts", clears the phone.
- AC4 Every account on the phone registers the push token with its own tag, each push says whose it
  is when there is more than one account, and a tap opens the right account.
- AC5 A phone signed in before this version keeps its account after the update.

## Implementation notes

- **The token store.** `AccountTokens` replaces `SecureTokens`. Its slot changes only through
  `point_at` (inside `Session::switch`, under the session's lock) and `rename` (pending to
  `tokens:{id}`, under the store's own lock), so a refresh that lands mid-change still saves where
  it belongs. `SlotTokens` is a fixed slot for the pending sign-in and for accounts not in use.
- **Sign-in results.** Passkey, provider and QR results now come back as `Done::Local`, guarded by
  their own generations, so a computer link ending while an account is being added does not drop
  them.
- **Website.** The unique index on `PushToken` became one on `(UserId, PushToken)`
  (`PushDevicesPerAccount`). Registering takes over only the same person's earlier session on that
  phone. A token the push service no longer knows is removed for every account. The tag is
  `accountTag` on `PUT /accounts/me/push-devices/current`, 8 to 32 URL-safe characters, never
  returned.
- **Avatars.** Initials, a colour from six (steady per account) and "last used" come from the core.

## Not verified

- iOS (the screens, the label map in the shared keychain, the notification extension) is
  unverified until the Mobile iOS CI job builds it.
- Real FCM and APNs deliveries of tagged pushes were not tried; only the generated payloads are
  tested.
- Not tried by hand on a phone with two real accounts.
