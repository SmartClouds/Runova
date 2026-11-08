# E64 Runova Anywhere: the background agent on Windows

Milestone: standalone (Remote, Website). Depends on: E60, E61, E62.

## Goal

A Windows computer stays reachable through Runova Anywhere while no one is signed in to it, or while
it is locked, under the same Runova ID, the way AnyDesk's and TeamViewer's services do. The
controller sees the lock or sign-in screen and can type the password to sign in.

## Design

- **The agent** (`apps/remote-agent`, .NET 10): a Windows service running as LocalSystem
  (`RunovaAgent service`) starts `RunovaAgent run` as SYSTEM in the session at the physical console,
  keeps it alive and moves it when the console session changes. That helper talks to the website,
  captures the screen with GDI and injects input with SendInput from one thread that switches to
  the input desktop before each call, so it sees and drives the Winlogon desktop (lock and sign-in
  screens) and the UAC prompt's secure desktop.
- **The protocol, unchanged**: the agent implements the handshake (libsodium for Ed25519, X25519,
  ristretto255 and scrypt), link framing and the relay cipher in C#, and its tests replay the
  vectors `packages/protocol` writes, byte for byte, in both roles and both modes. It streams JPEG
  tiles of what changed and answers a WebRTC video request with "unavailable", so the controller
  shows tiles as for any host without video. The agent has no WebRTC: it tells the controller to go
  to the relay at once.
- **Its own rules**: no one is there to accept, so it lets in only the password, the owner's own
  computers when allowed, and teammates always let in. Files and the clipboard are not offered.
  The password lockout is the app's.
- **Its own credentials**: the app makes the agent a key of its own and registers it
  (`POST /api/v1/remote-devices/{id}/agents`), getting a one-time secret the server keeps only the
  SHA-256 of. The agent trades it for an `ra1.` token that lasts an hour and works on the remote hub
  only, where it can host its own computer and never ask to connect. A request goes to the app when
  it is online and to the agent otherwise; the controller pins the agent's key apart from the app's.
- **Setting it up**: the app writes the config (site, ID, the agent's seed and secret, the agent's
  password secret, the owner's choices) to a file only this user can read and runs
  `RunovaAgent install --config` through a UAC prompt. The installer seals it to the machine with
  DPAPI in a folder only SYSTEM and administrators can open, copies itself to Program Files and
  registers the service. With a password set the app asks for it once more, checks it against its
  own, and derives the agent's secret; a new password sets the agent up again.
- **Shipping**: `pnpm remote-agent:publish` writes a self-contained single file into
  `apps/desktop/build/remote-agent`; CD runs it on the Windows build and electron-builder copies it
  into the app's resources. A build without it says the background service is not part of it.

## Tasks

- [x] T1 Agent devices, secrets and tokens on the website, the hub's agent rules and routing, with
  integration tests and the contract
- [x] T2 The protocol in C# against the app's vectors (handshake, framing, relay cipher)
- [x] T3 The agent's link, host session (tiles, input, refusals) and policy, with tests
- [x] T4 The agent executable: service supervisor, session helper, GDI capture, SendInput, relay
  transport, hub client with token refresh, sealed config, installer
- [x] T5 The app: agent installer, turning the agent on and off, pins per kind, the setting in Access
  settings, the help article
- [x] T6 CI job for the agent, the publish script, CD and packaging

## Acceptance criteria

- AC1 The agent and the app produce the same handshake messages, keys, safety code, frames and
  sealed frames from the same inputs.
- AC2 An agent token opens nothing but the remote hub, can host only its own computer, and stops
  working when the agent is turned off or set up again.
- AC3 With the app away the agent answers with its own key; with the app online the app answers.
- AC4 The agent lets in only what the owner allowed without asking.
- AC5 Turning the agent on asks Windows for permission and, with a password set, for the password,
  which must match; a failed install leaves no agent registered.

## Not in this epic

macOS and Linux (E65), WebRTC and video in the agent, the clipboard and files on the sign-in
screen, and updating the agent's settings without setting it up again.
