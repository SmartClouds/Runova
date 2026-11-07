# E56 Desktop: online monitors

Milestone: standalone (Account). Depends on: E55 (online monitors), E22 (Monitoring).

## Goal

On the Monitoring page each monitor can run on **This computer** or on **Runova Cloud**. A cloud
monitor is not checked locally; its status, history and incidents come from the server, and new
results arrive live over SignalR. Local and cloud monitors sit in the same list. Alerts arrive in
the inbox and as OS notifications, and the monitor can also send them to Telegram.

## Design

- The stored monitor gets `runMode` (`local` or `cloud`) and `cloudMonitorId`. Both sync, so a
  teammate's app shows the monitor as online too and does not check it.
- The scheduler skips cloud monitors.
- `main/health/cloud.ts` turns a monitor online (it sends the address, timing, names and, with the
  person's consent, the access key), back to local, paused or resumed, changes its interval and
  notifications, and passes a rotated key on. It keeps the latest server status per monitor, fed by
  `CloudMonitorUpdated` on the hub connection the app already has (`websiteAlertHub`).
- Summaries and details for cloud monitors are built from the server's data, so the board, cards
  and details work as before.
- Signed out, a cloud monitor says so and is not checked.
- `monitor-down` and `monitor-recovered` notifications become inbox entries that open the monitor.
  With auto diagnosis on, the app still runs the local diagnosis.

## Tasks

- [x] T1 Store fields, sync, and the scheduler skipping cloud monitors.
- [x] T2 `cloud.ts` with its account client calls and the hub subscription, test-first.
- [x] T3 IPC `health.cloud*`, preload, zod schemas.
- [x] T4 Summaries and details from server data.
- [x] T5 UI: "Where it runs" in the monitor dialog with the plan and usage, the consent line,
  interval presets above the floor, notifications (in-app, Telegram with the link flow), the cloud
  badge and region on the card, the history chart and incidents in the details.
- [x] T6 Inbox entries for server monitor notifications.
- [x] T7 e2e: turn a monitor online, a live update arrives, pause it.

## Acceptance criteria

- AC1 A cloud monitor is never checked by the app, on this computer or a teammate's.
- AC2 Its status changes on the page within a second of the server knowing.
- AC3 Turning a monitor online is refused, with the reason and a way forward, when signed out,
  when the type's limit is reached, or when the address is local.
- AC4 The access key is only sent after the person agreed to it, and never shown again.

## Implementation notes

- **Where it lives.** `main/health/cloud.ts` is the service (built on injected calls, so its tests
  run against a fake API), `main/health/cloudLive.ts` binds it to the account, the health store and
  the Servers vault, and `packages/core/src/health/cloud.ts` holds the pure rules the dialog and the
  service share: which addresses Runova Cloud can check, the interval choices above a type's floor,
  and how the key is sent (`user:password` for HTTP Basic).
- **Run mode on the stored monitor.** `runMode` and `cloudMonitorId` sit on the monitor record and
  sync with it, so a teammate's app shows it online and its scheduler skips it as well (AC1). An
  older file or an older computer reads as `local`.
- **The server's results stand in for this computer's.** For a cloud monitor the IPC list and
  detail build the usual result record from the server: the last status as the report, the samples
  of the last 24 hours (with percentiles worked out here), the hours further back, and the
  incidents. So the board, the cards, the charts and the detail did not change shape. The server
  keeps no services or body, so a cloud monitor's detail shows the one line it has.
- **Live.** The online monitors listen on the hub connection the dependency alerts already hold
  (a new `attach` hook): `CloudMonitorUpdated` updates the cached status and appends the sample, so
  a card moves without another request (AC2); `CloudMonitorsChanged` and every reconnect read the
  list again. Without the hub, the list is read once a minute while any monitor is online.
- **Changes go to the server first.** Editing, pausing, rotating the key and removing a cloud
  monitor call the server before the local copy changes, so a refused change (an interval the type
  does not allow, a resume over the limit) leaves both as they were. Check now becomes Refresh.
- **The dialog.** "Where it runs" asks for the plan by the project only and checks the address as
  it is typed. It moves an interval under the floor up, shows the type and its use, says why the
  monitor can not go online with the way forward (Sign in, See account types) (AC3), asks for
  consent before the first send of the key (AC4), and holds the in-app and Telegram alerts (with
  Link Telegram when no chat is linked) and, once online, mute for me. Adding a monitor online makes
  it locally first, then turns it online, so the one-time key step still shows if that fails.
- **Inbox.** `monitor-down`, `monitor-recovered` and `monitor-plan` become `health-failure` and
  `health-recovered` entries that open the monitor (`dependencyAlerts/inbox.ts`).
- **Tests.** 21 core rule tests, 18 service tests (consent, the refusals, joining a monitor a
  teammate turned online, the live update, the history, pause and the settings), store, scheduler,
  summary, adapter, inbox and IPC tests, 5 dialog tests and a card test, and `cloudMonitors.e2e.ts`
  against the fake account server.

## Known limits

- The desktop e2e has no hub (the fake account server has none), so it reads a result with
  Refresh; the live update is covered by the main process tests and the E55 hub test.
- With auto diagnosis on, a cloud monitor's incident is not diagnosed on this computer: there is no
  local report to read.
- Removing a cloud monitor while signed out leaves the server's copy running; it can be removed on
  the website's Monitoring page (E57).
- A monitor added online is made locally first, so its first check may run here before it goes
  online.
