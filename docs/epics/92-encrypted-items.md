# E92 Encrypted notifications and sync on paid plans

Milestone: standalone (Mobile). Depends on: E82, E48.

## Goal

On Go, Pro and Ultra, a person can turn on end-to-end encryption for each kind of item separately: the
notifications their computers forward, and their cloud sync. Each has its own switch, on the computer
and on the phone. On those plans with the switch on, the server can't read the item's text.

## What it does not change

- Remote sessions and secrets in sync are end-to-end encrypted on every plan, as they were.
- The switches for also sealing servers and environments in sync stay open to every plan.
- Connections to the server use TLS, as they always have. That part isn't end to end.
- The server still sees that something happened: the category, the time, which account, and that the
  item is sealed. Only the text is hidden.
- Notifications the server writes itself (cloud monitors, plan and dependency alerts) can't be sealed,
  because the server has to know what they say in order to write them.

## How it works

Each phone works out an X25519 key from its identity seed and gives the public half to each computer
that has approved it, over the Manage link, which that computer already trusts. The server is never
in a position to swap the key.

The computer writes the line itself from the same templates the server uses, seals one copy for each
phone it knows, and sends those copies with the category and nothing else. The server keeps them and
hands each phone its own. A phone with no copy (say, one that has not connected to this computer since
the switch went on) shows a generic line.

Format: `packages/protocol/test-vectors/sealed-item-v1.json`, replayed by the desktop and the Rust
core. The context bound to each item is `notification:<category>`, so a sealed line can't be passed off
as a different category. Templates: `packages/protocol/test-vectors/push-lines-v1.json`, replayed by
the API tests and the desktop tests.

## API contract

All new JSON is camelCase, and new request records refuse unknown members like their neighbors do.

### Plans

- `AccountType.EncryptedItems` (bool, seeded false for free, true for go, pro and ultra), editable by
  admins and included in `AccountTypeDto` and the write request as `encryptedItems`.
- `Entitlement` gets `EncryptedItems`. `Best` is true if any payer has it.
- The pricing page and the account plan page add the line `Encrypted notifications and sync` when
  `encryptedItems` is true. The line isn't stored in `Features`, so no admin text is overwritten.

### Switches

`GET /api/v1/accounts/me/encryption` (Policies.Account) answers:

```json
{
  "entitled": true,
  "planName": "Pro",
  "items": [
    { "item": "notifications", "label": "Notifications", "enabled": true, "active": true, "lapsed": false, "needsKey": false },
    { "item": "sync", "label": "Cloud sync", "enabled": false, "active": false, "lapsed": false, "needsKey": true }
  ]
}
```

- `enabled` is what the person chose. A row in the new `UserEncryptionPreference` table (UserId, Item,
  Enabled, UpdatedAt); no row means off.
- `active` is `enabled && entitled`, and for `sync` also that the personal scope is really sealing
  everything.
- `lapsed` is `enabled && !entitled`, which is what the clients warn about.
- `needsKey` is only ever true for `sync`, when the personal sync scope has no key yet.

`PUT /api/v1/accounts/me/encryption/{item}` with `{ "enabled": bool }` answers with the same body.

- Unknown item: 404.
- Turning on without the plan: 403 problem with `extensions.code = "plan-required"` and
  `extensions.accountType` (key).
- Turning `sync` on with no key: 409 problem with `extensions.code = "needs-key"`.
- Turning off always works, on any plan.
- For `sync` it also sets `EncryptEverything` on the person's personal sync scope.

`PATCH /sync-scopes/{id}`: turning `everything` from off to on needs `ForScopeAsync(...).EncryptedItems`,
or the same 403. Turning it off, leaving it on, and the servers and environments switches are never
gated. On a personal scope the change also updates the `sync` preference row, so the two can't disagree.

### When a plan changes

The same driver that pauses cloud monitors after a downgrade (`PlanEnforcement`) also does this:

- Payers no longer entitled: `EncryptEverything` goes off on their scopes. The preference row stays, so
  `lapsed` is true and the clients warn.
- Entitled again: scopes whose preference row is still on and that have a key go back on.
- What is already sealed stays sealed and readable. Clients just stop sealing new records in full.

Team scopes follow the team owners' plans through `ForScopeAsync`, the same rule as cloud monitors.

### Forwarded notifications

`GET /accounts/me/notification-listeners` adds `sealing` (bool), true when the `notifications` item is
active for this user. The desktop already reads this once a minute.

`POST /notification-events` adds an optional `sealedFor`:

```json
{ "category": "deploys", "itemId": "p1", "sealedFor": [{ "keyId": "AbCdEfGhIjKl", "sealed": "<base64url>" }] }
```

- With `sealedFor` present, `status`, `agent`, `project` and `subject` have to be null or absent, or 400.
- 0 to 8 entries (none means this computer knows no phone yet, and the event is still sealed), `keyId` matches `^[A-Za-z0-9_-]{12}$` and is unique, `sealed` is base64url of at most
  1024 characters.
- Not entitled: 403 problem with `extensions.code = "plan-required"`, nothing stored. The category,
  listener and rate checks work as they do now.
- Stored as a normal forwarded row with `Title = "New activity on your computer"`, `Body = ""`, no
  severity, and the copies in a new nullable `Sealed` column.

`UserNotificationDto` adds `sealed`, an array of `{ keyId, sealed }` or null, going through the Mapperly
mapper.

`PUT /accounts/me/push-devices/current` adds optional `sealKeyId` (same pattern), kept on
`PushDevice.SealKeyId`.

### Push

For a sealed notification, each device gets the copy matching its `SealKeyId`:

- FCM with a copy: a data-only message (no `notification` block, so the app's service runs), data
  `category`, `notificationId`, `itemId` (when set), `sealed`, and `fallback` holding the generic line.
  `android.priority` stays high.
- APNs with a copy: the alert is the generic line, `aps.mutable-content = 1`, and a top-level `sealed`.
- No copy for that device: the generic line, sent the way a normal notification is sent today.

## Acceptance

- [x] AC1 The server refuses sealed items from an account whose plan doesn't include them
- [x] AC2 Each item has its own switch on the computer and the phone
- [x] AC3 With notifications on, the server stores no text, and the phone shows the real line
- [ ] AC4 A push shows the real line on Android and iOS (written, needs Firebase, APNs and a real phone)
- [x] AC5 Sync can seal whole records, and the app no longer overstates what is sealed
- [x] AC6 After a downgrade everything goes back to normal, with a clear warning
- [ ] AC7 Tried end to end with a real phone and a real push

## Decisions worth knowing

- A personal scope that was already sealing everything on a free plan goes back to normal at the next
  plan check and shows the warning, because whole-record sealing now belongs to the paid plans.
- A team scope has no remembered choice, so after a lapse a manager turns it back on by hand.
- A push that can't be opened shows the generic line, never nothing.

## State

Sealing is held to shared vectors between the desktop and the Rust core, and the line templates between
the desktop and the API. The API, desktop, core and Android parts are tested, with push senders against
fakes. No real FCM or APNs message has been sent. The iOS screen and notification extension have never
been compiled, and the extension needs its own App ID (`com.runovahq.app.notifications`) and a shared
keychain group on the Apple account.
