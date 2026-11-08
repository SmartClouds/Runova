# E79 Monitoring

Milestone: standalone (Mobile). Depends on: E73.

## Goal

See monitors and their history on the phone, with cloud monitors available even when the computer is
off.

## Design

Local targets use `health:*` through the computer under the `ops` scope. Cloud monitors use
`/api/v1/cloud-monitors` directly, with live updates from `/hubs/notifications`. The Errors tab uses
`errorTracking:*`.

## Tasks

- [x] T1 Bridge methods for local targets and errors
- [x] T2 Cloud monitor client in `api`
- [x] T3 `store` and screens: list, detail, history, check now, pause

## Acceptance criteria

- AC1 Local and cloud monitors appear in one list and each is labeled.
- AC2 With the computer off, cloud monitors still work and local ones say why they do not.
- AC3 A state change arrives live.

## Not in this epic

Creating monitors with AI.

## Status

The bridge, the core and the Android screens are tested. Local and cloud monitors share one list,
and cloud ones work with no computer connected. Cloud monitors refresh every 16 seconds until E82
brings the live hub (AC3), and the Errors tab is not on the phone yet. Owed: a real account, and
the iOS screens have never been compiled.
