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

- [ ] T1 API types and the hub client.
- [ ] T2 Grouping, formatting and the live reducer, test-first.
- [ ] T3 The page, the cards, the drawer and the charts.
- [ ] T4 Settings with If-Match and the conflict dialog; viewers read only.
- [ ] T5 e2e against the fake API: the list, a live update, a viewer.

## Acceptance criteria

- AC1 Someone in two teams sees their own monitors and both teams', each under its own name.
- AC2 A result on the server shows on the open page within a second.
- AC3 A viewer can not change a monitor; the controls say why.
- AC4 The page passes the site's accessibility and design checks.
