# E60 Runova Anywhere: Runova IDs, presence and signaling

Milestone: standalone (Website). Depends on: E41 (the website API), E48 (accounts, desktop device
tokens and teams), E51 (the SignalR setup and the hub token middleware).

## Goal

Every signed-in computer gets a Runova ID, a nine-digit number like 482 193 775, so another
signed-in computer can reach it from anywhere, the way AnyDesk or TeamViewer work. The website is
the meeting point: it knows which computers belong to which account, which are online, and passes
connection requests and WebRTC signaling between them. It never sees a screen, a keystroke or a
password.

## Design

- `RemoteDevice` holds the account, the nine-digit ID (random, never starting with 0, never given out
  again, unique index), the desktop's own device id (signing in again keeps the ID), the name, the
  platform, the computer's Ed25519 public key and three flags: `allowOwnDevices`,
  `unattendedEnabled` and the teams it is shown to (`RemoteDeviceTeam`). The flags only let the
  server turn away what the computer would refuse anyway. A new computer takes nothing.
- Who may ask (`RemoteAccess`): the owner's own computers and members of a team the computer is
  shown to, while the owner is still in that team. Anyone signed in may try the password, only on a
  computer that has one. A stranger gets the same `unavailable` answer for a missing ID as for one
  that refuses them, so IDs can not be enumerated for strangers.
- `RemoteHub` at `/hubs/remote` (device token, also as `access_token` on the hub path): `GoOnline`,
  `RequestConnect`, `Respond`, `Signal`, `Connected`, `End`. Presence and sessions live in memory
  (`RemotePresence`, `RemoteSessionRegistry`); a session id is 128 random bits and every message is
  checked against the two connections in it. Signaling passes only after the host accepts, up to
  64 KiB a message and 600 a minute, and is never logged or stored.
- Limits: 20 requests a minute per account, 30 password requests per 10 minutes per computer from
  everyone together, 8 open sessions per connection, 60 seconds of ringing.
- A session is recorded only when the host reports the encrypted handshake succeeded, so a wrong
  password leaves no record. A record says who connected to which computer, how and when, nothing
  else; it is kept 30 days (nightly job) and either side can delete it.

## Tasks

- [x] T1 Entities, model and migration (`RemoteDevices`, `RemoteDeviceTeams`, `RemoteSessionRecords`)
- [x] T2 Runova IDs, access rules, rate limiter, presence and the session registry, with unit tests
- [x] T3 `/api/v1/remote-devices`, `/api/v1/reachable-devices`, `/api/v1/remote-sessions` with
  integration tests
- [x] T4 `RemoteHub`, the ringing sweeper and the retention job, with integration tests
- [x] T5 Mapperly mapper and its tests (no secret in any DTO), the contract and the OpenAPI snapshot

## Acceptance criteria

- AC1 Registering twice from the same computer keeps the ID; removing a computer retires its ID.
- AC2 A computer can be shown only to teams its owner is in, and leaving the team hides it.
- AC3 A teammate's request rings the host with who is asking and from which computer; accepting
  lets the two exchange signaling, declining or a minute of silence does not.
- AC4 A stranger can not ring a computer without a password, and can not tell a real ID from a
  made-up one.
- AC5 The server records a session only after the host says the handshake succeeded.

## Not in this epic

The desktop side (E61), the relay (E62), and the agent that keeps a computer reachable when no one
is signed in (E64, E65). The hub keeps its state in memory, so the API runs as one instance while
Anywhere is on it (see RISKS.md).
