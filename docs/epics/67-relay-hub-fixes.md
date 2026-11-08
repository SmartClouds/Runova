# E67 Relay reachability and hub limits

Milestone: standalone (Website). Depends on: E62.

## Goal

The relay works in production, and the hub's limits are stated instead of inherited, because phones
on mobile networks depend on the relay far more than desktops do.

## Design

- `/relay/*` is missing from the `@api` matcher in `apps/website/Caddyfile` and in
  `apps/website/docker-compose.production.yaml`, so relay requests reach the web container, which
  has no such route. Background agents use only the relay, so they are affected too.
- `MaximumReceiveMessageSize` is unset on `RemoteHub`, so the 32 KiB default sits below the code's
  64 KiB signal limit.
- Closing hub connections when a sign-in ends was done separately (`RemoteHubConnections`). This
  epic only checks it covers phones in E68.
- `docs/RISKS.md` already records the relay's missing byte quota.

## Tasks

- [ ] T1 A test that reads both proxy configs and fails when a route the API serves is not matched
- [ ] T2 `/relay/*` in both matchers
- [ ] T3 An explicit receive limit on the hub, with a test that a 64 KiB signal is accepted
- [ ] T4 A per-session byte quota on the relay, with a test

## Acceptance criteria

- AC1 A request to `/relay/remote/{id}` reaches the API in both proxy configs.
- AC2 A signal of the largest allowed size passes through the hub.
- AC3 A relay session over its quota ends for both sides and says why.

## Not in this epic

TURN, a backplane, or running the relay on more than one instance.
