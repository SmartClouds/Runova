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

- [ ] T1 Store fields, sync, and the scheduler skipping cloud monitors.
- [ ] T2 `cloud.ts` with its account client calls and the hub subscription, test-first.
- [ ] T3 IPC `health.cloud*`, preload, zod schemas.
- [ ] T4 Summaries and details from server data.
- [ ] T5 UI: "Where it runs" in the monitor dialog with the plan and usage, the consent line,
  interval presets above the floor, notifications (in-app, Telegram with the link flow), the cloud
  badge and region on the card, the history chart and incidents in the details.
- [ ] T6 Inbox entries for server monitor notifications.
- [ ] T7 e2e: turn a monitor online, a live update arrives, pause it.

## Acceptance criteria

- AC1 A cloud monitor is never checked by the app, on this computer or a teammate's.
- AC2 Its status changes on the page within a second of the server knowing.
- AC3 Turning a monitor online is refused, with the reason and a way forward, when signed out,
  when the type's limit is reached, or when the address is local.
- AC4 The access key is only sent after the person agreed to it, and never shown again.
