# E78 Deploy

Milestone: standalone (Mobile). Depends on: E73.

## Goal

Check servers and act on the common cases from the phone.

## Design

Goes through the desktop's existing Deploy service and tunnels under the `deploy` scope. Covers
servers, health, containers (start, stop, restart, logs), stacks and redeploy, the problems feed and
backup status. Destructive actions ask first. Logs stream only while visible.

## Tasks

- [x] T1 Bridge methods over the Deploy service
- [x] T2 `store` and screens for servers and overview
- [x] T3 Containers and logs
- [x] T4 Stacks, problems and backups

## Acceptance criteria

- AC1 Server state matches the desktop's.
- AC2 Restarting a container from the phone really restarts it, after asking.
- AC3 An unreachable server says so instead of hanging.

## Not in this epic

The rest of CoreHub, including firewall rules and nginx editing.

## Status

The bridge, the core and the Android screens are tested, using the same service instances and problem
logic as the desktop's Deploy pages. Logs re-read every few seconds while open rather than streaming.
Owed: AC1 and AC2 against a real server, and the iOS screens have never been compiled.
