# E51 Dependency update alerts

Milestone: standalone (Account). Depends on: E41 (the website API), E48 (accounts, sync and teams),
the Packages tab (Node, .NET and Dart package adapters).

## Goal

Runova checks the packages of every project once a day, at a time that moves from day to day, even
with the app closed. When it finds something the person asked to hear about (a security advisory
from a chosen severity up, a deprecated package, a major, minor or patch release), it tells them in
the app (a message in the inbox, an OS notification, a badge on Projects and a chip on the
project's card and row), on the website's Notifications page, and on Telegram through the RunovaHQ
bot. A team's project tells every member, each by their own settings. The feature can be turned off
for the account and muted per project.

## Design

- **The server checks, the app sends the list.** Projects live on each computer and sync records
  may be sealed, so the server can not read them. The desktop reads each project's direct
  dependencies from its manifests and lock files (`readInventory` on each package adapter: no CLI,
  no network) and uploads the ecosystem, name, version and dev flag, never a path, to
  `PUT /sync-scopes/{scopeId}/package-inventories/{itemId}`. The scope is the account's own or the
  project's team (`teamMap`), so team membership decides who hears about it. The app sends a
  project again only when its list or its scope changed (`dependency-alerts.json` keeps a hash),
  at sign-in, every 6 hours and after a Packages update. A project that moved scope has its old
  copy deleted.
- **The daily check.** `DependencyCheckJob` (Hangfire, every 15 minutes) takes the inventories whose
  `NextCheckAt` has come. It asks npm (the install document's dist-tags and deprecation), NuGet (the
  registration index's newest listed version and deprecation), pub.dev (latest and discontinued)
  and OSV (`querybatch`, then each advisory for its GitHub severity and fixed versions), once per
  package for every project through a 6 hour cache (`PackageFacts`, `AdvisoryLookups`). A registry
  that does not answer keeps what it said last. `FindingRules` turns each package into findings,
  stored per inventory with a stable key. The next check is a day later, give or take 3 hours
  (`CheckSchedule`); a new or changed inventory is first checked within the hour.
- **Who is told what.** `AlertNotifier` takes everyone who can see the scope (the account, or each
  team member; disabled accounts left out) and, for each, the findings their settings want
  (`AlertPolicy`) that they were not told about yet (`DependencyAlertDeliveries`, by the finding's
  key). A new release, a new advisory or a worse severity makes a new key. One message per project
  and check lists every new finding, worst first. It is saved (`UserNotifications`), pushed over
  SignalR, and queued for Telegram when the account linked a chat and left Telegram on.
- **Settings.** `DependencyAlertSettings` per account: on or off, the security threshold (critical,
  high, moderate, low, off), deprecated, major, minor, patch, in the app, on Telegram. The defaults
  are on, high and above, deprecations and majors. Turning it off deletes the inventories in the
  account's own scope; a team's stay for the other members. Mutes are per account and inventory.
  The desktop and the website edit the same row.
- **SignalR.** `NotificationsHub` at `/hubs/notifications` (Account policy), grouped by account id.
  It sends `NotificationCreated` and `DependencySummaryChanged`; clients call nothing. The desktop
  connects with its device token, which a WebSocket carries as `access_token` in the query: the API
  moves it to the Authorization header on the hub path only. The desktop catches up on unread
  messages each time it connects, and reads the findings every 30 minutes as a fallback.
- **Telegram.** A shared RunovaHQ bot (`Telegram__BotToken`, `Telegram__BotUsername`,
  `Telegram__WebhookSecret`). The account page asks for a one-time link
  (`https://t.me/<bot>?start=<code>`, 15 minutes, stored hashed); `/start <code>` at the webhook
  links the chat, `/stop` unlinks it. The webhook checks Telegram's secret header in constant time
  and is pointed at the site on start. Messages go through an outbox with the email outbox's
  backoff; a chat that blocked the bot is unlinked. The token is scrubbed from every error.
- **The app.** A `dependencyAlerts` IPC namespace (summary, refresh, settings, mute, Telegram), a
  `dependency-updates` inbox kind that opens the project's Packages tab, a Projects badge in the
  sidebar and the top menu, `DependencyAlertsChip` on each card and row (its accessible name never
  repeats the project's name), security and deprecation marks and an Alerts switch on the Packages
  tab, and a Package updates card in Settings > Notifications.
- **The website.** `/account/notifications`: the same settings (saved with If-Match), the Telegram
  link and the list of messages with Mark all as read.

## Tasks

- [x] T1 Version, finding, policy and message rules in Core, with unit tests.
- [x] T2 Tables and the `DependencyAlerts` migration; inventory endpoints.
- [x] T3 Registry and OSV clients, and the fake registries.
- [x] T4 The daily check with fan-out and its moving schedule; team tests.
- [x] T5 Settings, mutes, findings and notification endpoints.
- [x] T6 The SignalR hub, the query token on the hub path, and the pusher.
- [x] T7 The Telegram bot: link codes, webhook, outbox, webhook setup.
- [x] T8 Contract rows, the OpenAPI snapshot and the convention tests.
- [x] T9 `readInventory` on the Node, .NET and Dart adapters.
- [x] T10 Desktop service: uploads, the hub client, catch-up and the inbox.
- [x] T11 Desktop IPC and preload; the Projects badge, the card chip and the Packages tab marks.
- [x] T12 The Settings card; e2e `dependencyAlerts.e2e.ts`.
- [x] T13 The website Notifications page, its tests and the admin e2e.
- [x] T14 `/hubs` routed to the API in Caddy, the production gateway and the Astro dev proxy.
- [ ] T15 Run against real npm, NuGet, pub.dev and OSV, and a real bot and chat.

## Acceptance criteria

- AC1 A signed-in app sends each project's packages (names and versions only) into the project's
  scope, and sends it again only when it changed.
- AC2 A check finds advisories, deprecations and newer releases, and each account hears about the
  kinds it chose, once, in one message per project; a new release or a worse severity tells again.
- AC3 A team's project tells every member and viewer by their own settings; a removed member hears
  nothing more.
- AC4 A connected app hears a message at once over SignalR; an app that was closed catches up when
  it connects.
- AC5 Telegram links with a one-time code and sends the same alert; `/stop`, unlinking on the site
  or blocking the bot stops it; the token never shows in an error.
- AC6 Turning it off or muting a project stops the messages; off also deletes the account's own
  package lists.

## Implementation notes

- Test-first throughout: 54 Core unit tests, 41 API integration tests (inventories, the check,
  teams, notifications, the hub over long polling with a device token, Telegram with a fake Bot
  API), 8 adapter tests, 22 shared helper tests, 13 service tests, 6 IPC tests, renderer tests for
  the badge, the chip, the Packages tab and the Settings card, 9 website component tests, the
  desktop e2e and an admin e2e on the real API.
- The tests caught a real bug: a relative URI that starts with `bot123456:` is read as a URI
  scheme, so every Telegram call went to the wrong address until it was written `./bot...`.

## Known limits

- Not run against the real registries, OSV or a real bot yet (T15). Every client is tested against
  a fake that answers the way the public API documents.
- Direct dependencies only; Python, Rust and Go projects are not read. An npm range with nothing
  installed counts as its lowest version.
- A severity comes from GitHub's rating in OSV; an advisory without one counts as moderate.
- One API instance: SignalR has no backplane, so a second instance would push only to its own
  connections (the 30 minute refresh still catches up).
- The server's nginx in front of the production gateway must pass WebSocket upgrades for the hub;
  without them SignalR falls back to long polling.
