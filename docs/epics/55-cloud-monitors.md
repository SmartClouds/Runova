# E55 Online monitors on the server

Milestone: standalone (Website). Depends on: E53 (account types), E54 (nodes and the gateway),
E51 (notifications hub and the RunovaHQ bot).

## Goal

A monitor can run **online**: the nodes check it day and night, every result is kept on the
server, and when it goes down or comes back everyone who can see the project hears about it, in
the app and, if the monitor asks for it, on Telegram through the RunovaHQ bot. A team's monitor is
seen by the team, by each member's role. An online monitor can be paused (it then does not count
toward the limit).

## Design

- **Linked to the desktop monitor.** A `CloudMonitor` belongs to a scope (personal or team) and
  names the synced desktop monitor's item id. Synced records are sealed, so the desktop also sends
  the project, environment and monitor names in plain text, and the access key when it has one.
  The key is sealed with Data Protection and only sent to the node that checks it.
- **Results.** The gateway forwards each batch. The handler stores every sample, updates the
  current status and the hour bucket (kept forever), applies the two-sample rule, and opens or
  resolves an incident (kept forever). Raw samples are kept for the scope's type's history days.
- **A second opinion.** When a problem is confirmed on one node, another node (another region
  when there is one) checks it once. The incident opens only when it fails there too. With one
  node, the first node's word is enough.
- **Who hears.** `CloudMonitorNotifier` works like `AlertNotifier`: everyone who can see the
  scope, less anyone who muted the monitor. A `monitor-down` or `monitor-recovered` notification is
  saved and pushed; Telegram is queued when the monitor has Telegram on and the account linked a
  chat. Every result also pushes `CloudMonitorUpdated` over SignalR, so open pages stay live.
- **Limits.** Creating, resuming or shortening the interval checks the scope's type. When a type
  goes down (it ended, the owner changed, the Admin changed it), plan enforcement pauses the
  newest monitors over the limit and lengthens intervals below the new floor, and says so.

## Tasks

- [ ] T1 Data: `CloudMonitors`, `CloudMonitorStatuses`, `CloudMonitorSamples`,
  `CloudMonitorHourly`, `CloudMonitorIncidents`, `CloudMonitorMutes`, migration `CloudMonitors`.
- [ ] T2 Endpoints: list, create, read, update, delete, secret, samples, hourly, incidents, mute,
  usage; If-Match; viewers read only; a scope you can not see is 404.
- [ ] T3 Assignment (`MonitorAssigner`), rebalancing (`RebalanceJob`), snapshots on connect.
- [ ] T4 Ingestion, transitions, the second opinion and incidents.
- [ ] T5 `CloudMonitorNotifier`: in-app, SignalR, Telegram, mutes.
- [ ] T6 Plan enforcement and `SampleRetentionJob`.
- [ ] T7 Contract: `docs/website/api-contract.md` and the OpenAPI snapshot.
- [ ] T8 End to end: Postgres, RabbitMQ, a gateway and a node in process over mTLS, checking a
  fake health server.

## Acceptance criteria

- AC1 Free allows one active online monitor at 5 minutes or slower; Go ten; Pro fifty at one
  minute; Ultra any number at 30 seconds. A paused monitor does not count.
- AC2 A viewer of a team can read its monitors and not change them; someone outside the team
  gets 404.
- AC3 A monitor that fails twice on one node and once on another opens one incident and one
  notification per member, and one Telegram message per member who linked a chat when Telegram is
  on for that monitor.
- AC4 A batch sent twice is stored once.
- AC5 Hour buckets and incidents stay; raw samples older than the type's history go.
- AC6 When an owner's type goes down, the team's monitors are brought within the new limits and
  the members are told.
