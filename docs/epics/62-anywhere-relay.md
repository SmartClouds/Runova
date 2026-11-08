# E62 Runova Anywhere: the relay

Milestone: standalone (Remote, Website). Depends on: E60, E61.

## Goal

When two computers can not reach each other directly, the connection goes through the website
instead, still encrypted end to end, and the person sees which one they got.

## Design

- **When**: the controller gives a direct link 8 seconds (or until WebRTC says it failed), then
  sends `{"k":"relay"}` through the hub and both sides open the relay; the host waits twice as long
  on its own. **Always connect through the Runova relay** skips WebRTC, so the other side never
  learns this computer's address.
- **The website** (`RemoteRelay.cs`): the hub's `CreateRelayTicket` gives each side of an accepted
  session a one-time ticket (256 random bits, one minute, its own session only). Both open a
  WebSocket at `/relay/remote/{sessionId}?ticket=`; once the other side arrives (30 seconds) each
  gets `ready`, then binary messages up to 128 KiB are copied one at a time in each direction, so a
  slow side slows the other instead of filling memory. A text message, a larger message or either
  side leaving ends it for both; a session lasts at most 12 hours. Nothing is parsed or logged but
  that it paired and how long it lasted.
- **The desktop** (`relay.ts`, `relayCipher.ts`): every link frame after the handshake is sealed with
  AES-256-GCM under the direction's key from the handshake, as `[counter][ciphertext][tag]`; a frame
  out of order, played again or changed closes the link.
- Over the relay the video negotiation inside the link usually finds no direct path either, and the
  existing JPEG tile stream carries the screen.

## Tasks

- [x] T1 Relay tickets and the relay endpoint, with unit and integration tests
- [x] T2 `CreateRelayTicket` on the hub, the contract
- [x] T3 Frame cipher and relay opener on the desktop, with tests (a local relay in the test)
- [x] T4 The fallback in the link opener and **Always connect through the Runova relay**

## Acceptance criteria

- AC1 Two sides of an accepted session meet on the relay and frames pass both ways; one leaving
  closes the other.
- AC2 A ticket works once, for one minute, for its session; no ticket before the host accepts or for
  someone outside the session.
- AC3 The relay sees only sealed frames; a changed, repeated or reordered frame closes the link.
- AC4 The connection sheet says **Through the Runova relay**.

## Not in this epic

WebCodecs video over the relay (the tile stream is used instead), a TURN server, and running the
relay on more than one API instance.
