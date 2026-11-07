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

- [x] T1 Data: `CloudMonitors`, `CloudMonitorStatuses`, `CloudMonitorSamples`,
  `CloudMonitorHourly`, `CloudMonitorIncidents`, `CloudMonitorMutes`, migration `CloudMonitors`.
- [x] T2 Endpoints: list, create, read, update, delete, secret, samples, hourly, incidents, mute,
  usage; If-Match; viewers read only; a scope you can not see is 404.
- [x] T3 Assignment (`MonitorAssigner`), rebalancing (`RebalanceJob`), snapshots on connect.
- [x] T4 Ingestion, transitions, the second opinion and incidents.
- [x] T5 `CloudMonitorNotifier`: in-app, SignalR, Telegram, mutes.
- [x] T6 Plan enforcement and `SampleRetentionJob`.
- [x] T7 Contract: `docs/website/api-contract.md` and the OpenAPI snapshot.
- [x] T8 End to end: Postgres, RabbitMQ, a gateway and a node in process over mTLS, checking a
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

## Implementation notes

- **Where it lives.** `apps/website/api/src/Runova.Website.Api/CloudMonitoring/`: the endpoints,
  `MonitorAssigner` (both the assignment source and the rebalancer E54 left as seams),
  `CloudMonitorIngestor` (the result ingestor), `CloudMonitorNotifier`, `PlanEnforcement` and
  `SampleRetentionJob`. The pure rules (addresses, intervals, enforcement, the hour, the words of the
  alerts) are in `Runova.Website.Core/Monitoring/`, which now uses `Runova.Monitoring.Core` so the
  API checks addresses and transitions exactly as the nodes do.
- **The node is on the status row, not the monitor.** Moving a monitor to another node would
  otherwise change the monitor's ETag and spoil a person's edit; the same goes for each result. So
  `CloudMonitorStatuses` holds the node, the two-sample track, the last result, the open incident
  and the second opinion, and the monitor row changes only when someone changes it.
- **Hours, not an "hourly" table.** The rollup table is `CloudMonitorHours` and the endpoint is
  `/hours`, as paths are plural nouns. Hours hold checks, failures, warnings and the latency sum,
  count and maximum, so averages come out exact; percentiles come from the raw samples while they last.
- **Once and in order.** Samples go in with one `INSERT ... SELECT unnest(...) ON CONFLICT DO NOTHING
  RETURNING`, and only the ids it returns move the hours and the track, so a batch sent twice
  changes nothing (AC4). Status rows are locked `FOR UPDATE` in id order by both the ingestor and
  the assigner, so the two never wait on each other in a circle.
- **Which results count.** A result counts only from the node the monitor is on, for its current
  definition version (a change of address, interval, timeout, access or key bumps it), or for a
  second opinion from the node that was asked with the open question's id. A node that sends
  results for a monitor it should not have (deleted, paused, moved while it was away) is told to
  drop it with a delta.
- **The second opinion.** When the two-sample rule opens an incident on one node, the server picks
  another node (another region first, the least loaded) and sends `ConfirmCheck`. The incident
  opens, stamped at the confirming sample as on the desktop, only when that check also fails; a pass
  there resets the track. With no other node, or no answer within two minutes (looked at on the
  first node's next failure), the first node's word stands. Recovery needs no second opinion.
- **Grace for a node that drops its stream.** A node keeps its monitors while it was heard from in
  the last 45 seconds, even after its stream closed, so a gateway restart does not move everything
  twice. The liveness job now plans again every minute (it is the rebalance job), a node that
  connects gets its snapshot and then whatever the plan moves to it, and a drain or a revoke plans
  again at once.
- **Limits.** Creating an active monitor, resuming one and setting an interval check the scope's
  type under a row lock on the scope, so two requests can not both take the last slot. Plan
  enforcement runs after the expiry job, a payment or an Admin's grant (as E53 already called it),
  after an Admin changes a type, when a team's owners change, and nightly with retention.
- **Who hears.** Members come from the same query as the dependency alerts. `notifyInApp` off saves
  no notification but the live push still goes to everyone; Telegram goes only when the monitor
  has it on and the member linked a chat. The plan notice goes to every member, in the app and on
  Telegram when linked.
- **Live.** The hub gained `CloudMonitorUpdated` (after each result, for every member) and
  `CloudMonitorsChanged` (a scope's list changed). Members are read per batch and scope, not cached.
- **Fixes to E54 found by the end-to-end test.** The node made its SQLite tables after the services
  that use them started, so on a fresh volume its first stream failed; the setup now runs first. A
  node stopping in the middle of a stream logged a crash (the cancelled call is an `RpcException`);
  it now just stops.
- **Tests.** 43 rule unit tests; 28 API integration tests: the endpoints and access (15), the
  results, second opinion, alerts, retention, enforcement and rebalancing (11), the hub push, and
  the end to end run (the API on Wolverine with PostgreSQL and RabbitMQ, the real gateway over
  mutual TLS, a real node that enrolls and checks a health server on this machine through a
  down and an up). The integration tests now reference the gateway and the node and share the link
  tests' PKI, gateway harness and HTTP server; .NET 10 makes a web app's `Program` public, so the
  API's is named through an `api` alias there.

## Known limits

- The end-to-end test makes its monitor straight in the database, since the API refuses addresses
  on this machine (as it must); every other step is the real one.
- A result a node checked just before its monitor moved is dropped, and so are results for a
  definition that changed while they were in flight.
- The confirm timeout is checked when the first node reports again, so for a monitor checked every
  hour an unanswered second opinion waits up to the next check.
- Members are looked up for every batch rather than cached; fine at this size, worth a cache with
  many large teams.
- Pausing a monitor with an open incident leaves the incident open until it is resumed and recovers.
