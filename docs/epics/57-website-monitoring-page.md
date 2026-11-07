# E57 Website: Monitoring page

Milestone: standalone (Website). Depends on: E55 (online monitors).

## Goal

The account panel gets a **Monitoring** page that shows every online monitor the person can see,
their own and their teams', live. A team's monitors are shown to each member by their role: a
viewer can look, a member can pause and change them.

## Design

- `/account/monitoring`, in the Data group of the account menu, a React island.
- The header says how things are ("All 12 monitors up", "2 down") and switches between Personal
  and each team.
- Monitors are grouped by project, then environment. A card shows a live status dot, 90 bars of
  uptime, a latency line, when it was last checked and from where.
- A drawer shows the response time over 24 hours, 7, 30 or 90 days, the incidents, and the latest
  result from each region, and holds the settings: pause, interval within the type, in-app and
  Telegram, mute for me. A viewer sees them read only.
- Monitors are made in the app, because the project needs the health endpoint first. The empty
  state says so and links to the download page.
- Live through `@microsoft/signalr` on `/hubs/notifications` with the session cookie, reconnecting
  by itself, with a Live mark; while it is away the page asks every 30 seconds.
- It follows `docs/website/design.md`.

## Tasks

- [x] T1 API types and the hub client.
- [x] T2 Grouping, formatting and the live reducer, test-first.
- [x] T3 The page, the cards, the drawer and the charts.
- [x] T4 Settings with If-Match and the conflict dialog; viewers read only.
- [x] T5 e2e against the fake API: the list, a live update, a viewer.

## Acceptance criteria

- AC1 Someone in two teams sees their own monitors and both teams', each under its own name.
- AC2 A result on the server shows on the open page within a second.
- AC3 A viewer can not change a monitor; the controls say why.
- AC4 The page passes the site's accessibility and design checks.

## Implementation notes

- **Where it lives.** `src/pages/account/monitoring.astro` mounts
  `components/account/monitoring/Monitoring.tsx`; the cards, the drawer, the charts and the hub
  client sit beside it, and `src/lib/account/monitoring.ts` holds the pure parts the tests cover:
  the API shapes, grouping by scope, project and environment, the header line, the live reducer,
  the 90 daily bars, the latency line, the newest result per region and the labels.
- **Live.** `@microsoft/signalr` (10.0.11, the version the app uses) connects to
  `/hubs/notifications` with the session cookie. Its negotiation is a POST with the cookie, so it
  sends the antiforgery header like every other unsafe call (`antiforgeryToken` is now exported
  from `lib/admin/api.ts`). `CloudMonitorUpdated` moves one card at once (AC2);
  `CloudMonitorsChanged` and every reconnect read the list again. While the hub is away the mark
  says so and the list is read every 30 seconds.
- **Cards.** Each card reads its own 90 days of hours, again whenever a new result lands, for the
  uptime bars (one per UTC day, each with its share in words) and the last day's latency line.
- **The drawer.** A Radix dialog on the right: an open incident with where it was seen and
  confirmed, the numbers, response time for 24 hours (from the samples, failed checks as red
  ticks) or 7, 30 and 90 days (from the hours), the newest result from each region, the incidents,
  and the settings. Each change is a merge patch with `If-Match`; a 412 says the monitor changed
  elsewhere and offers to read it again. A Viewer sees the settings disabled with why, and can
  still mute it for themselves (AC3).
- **Empty.** With no online monitors the page says they are made in the app, where the project's
  health endpoint lives, and links to the download page.
- **Design.** The account panel's own surfaces: glass cards, pills for chips and the range and
  scope switches, the box radius for the drawer, inner for rows; status always as a word and an
  icon besides the color; the live dot breathes only while the page is live and stays still under
  reduced motion.
- **Tests.** 9 library tests, 7 page tests (the groups, a live update, a list change, pausing with
  the version, a conflict, a Viewer, the empty page), and `e2e/admin/monitoring.spec.ts` against the
  real API with the real hub: an account with a personal monitor and two teams', a monitor added
  elsewhere showing up live, a pause from the drawer reaching the server, and a Viewer who can only
  look. The phone check in `account.spec.ts` covers the page too (AC4). The fake fetch of the unit
  tests now takes prefix routes for queries with a time in them.
- **The e2e proxy passes WebSockets.** The admin e2e stack's HTTPS proxy forwarded plain requests
  only, so the hub's WebSocket hung there; it now joins an upgrade on `/hubs` to the API, as Caddy
  does in production. The phone check in the spec also measures each card, which caught the 90
  bars running out of a card at 360 px.
- **Lockfile.** Adding the package also dropped a stale `three` entry from the website's
  `pnpm-lock.yaml` that `package.json` no longer had.

## Known limits

- No node runs in the website e2e, so the monitors there wait for their first check; a result
  arriving live is covered by the page tests (a fake hub) and the API's hub and end to end tests.
- Each card reads its own hours, so a page with very many monitors makes one request per card.
