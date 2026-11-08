# E78 Deploy

Milestone: standalone (Mobile). Depends on: E73.

## Goal

Check servers and act on the common cases from the phone.

## Design

Goes through the desktop's existing Deploy service and tunnels under the `deploy` scope. Covers
servers, health, containers (start, stop, restart, logs), stacks and redeploy, the problems feed and
backup status. Destructive actions ask first. Logs stream only while visible.

## Tasks

- [ ] T1 Bridge methods over the Deploy service
- [ ] T2 `store` and screens for servers and overview
- [ ] T3 Containers and logs
- [ ] T4 Stacks, problems and backups

## Acceptance criteria

- AC1 Server state matches the desktop's.
- AC2 Restarting a container from the phone really restarts it, after asking.
- AC3 An unreachable server says so instead of hanging.

## Not in this epic

The rest of CoreHub, including firewall rules and nginx editing.
