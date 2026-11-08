# E61 Runova Anywhere: connect by ID, as a teammate or with a password

Milestone: standalone (Remote). Depends on: E60 (IDs and signaling), E48 (the account runtime),
the Remote page's remote control (WebRTC video, input, file transfer).

## Goal

The **Anywhere** tab, first on the Remote page: this computer's ID and who may use it, a field to
connect to any other computer by its ID, the account's own computers and its teammates' computers,
and the windows the host needs: a request window over everything and a bar at the top of the screen
while anyone is connected. Signed out, the tab asks to sign in.

## Design

- **A link, then the usual remote control.** The controller and the host first open a link: a
  WebRTC data channel made in the main window (Node has no WebRTC) and signaled through the hub
  (`rtcLinks.ts`, `lib/anywhere/linkPeer.ts`). Over it runs the handshake, then the link is handed
  to `RemoteManager` as an already authenticated peer (`attachHostPeer`, `attachClient`). From
  there the existing flow negotiates the screen video over the link, with the quality governor and
  the JPEG tile fallback as on a LAN. `RemoteManager` speaks a `PeerSocket` instead of a `ws`
  WebSocket, so the LAN path is unchanged.
- **Link framing** (`@runova/protocol` `link.ts`): text, binary and fragment frames of at most
  60 KiB, so a large message fits any data channel.
- **The handshake** (`@runova/protocol` `secure/handshake.ts`, sans-IO): fresh X25519 keys signed
  with each side's Ed25519 identity key over a transcript that includes both DTLS fingerprints as
  each side saw them, so a signaling server that swapped them would break the signatures. HKDF gives
  one key per direction and a six-digit safety code. In password mode both sides also run CPace on
  ristretto255 with a secret derived from the password and the host's key (scrypt N=2^15): the
  password never leaves the controller, the host keeps only the derived secret (sealed by the OS
  keychain), and a wrong guess teaches nothing that could be tested offline.
- **Decisions stay on the host** (`accessPolicy.ts`): own computers get in without asking only when
  turned on, a teammate only when always allowed and still in a shared team, a password request goes
  to the handshake only when a password is set; everyone else is declined. Wrong passwords wait 1,
  2, 4... seconds and lock password access for 15 minutes after 10.
- **Per-session permissions**: control, clipboard and files are separate, chosen when accepting;
  `RemoteManager` drops input from a view-only session, answers file requests from a session without
  files with a refusal, and **Pause input** stops all input without ending sessions.
- **Secrets at rest**: the identity key and the password secret are sealed by safeStorage in
  `anywhere.json`; saved passwords for other computers (the derived secret, never the password) are
  sealed by the Servers vault in `anywhere-saved.json` and move with a passkey change. Host keys are
  pinned per ID; a changed key stops the connection until the person trusts it.

## Tasks

- [x] T1 Link framing and the handshake in `@runova/protocol`, with tests
- [x] T2 `SecureLink` over any transport, with tests
- [x] T3 `RemoteManager` on `PeerSocket`, `attachHostPeer`, `attachClient`, permissions and
  pause, with the first manager tests
- [x] T4 Settings store, access policy and lockout, saved passwords, API and hub clients
- [x] T5 The Anywhere service (connect, accept or decline, serve, pins, recent), tested against a
  simulated website with two and three computers
- [x] T6 WebRTC link opener in main and the link peer in the renderer, with tests
- [x] T7 IPC, preload, the request window and the host bar windows, wiring to the account
- [x] T8 The Anywhere tab, the connection sheet, access settings, request window and host bar, with
  component tests; the help article

## Acceptance criteria

- AC1 Signed out, the tab explains the feature and signs in.
- AC2 Typing an ID groups the digits and connects; own and teammates' computers are listed with
  their presence.
- AC3 A teammate's request shows the request window; accepting with view only connects both sides
  and drops input; declining or a minute of silence tells the controller.
- AC4 With the right password a stranger connects without anyone accepting, and can save it; a
  wrong one says so, counts towards the lockout and leaves no session.
- AC5 Both sides show the same safety code; a changed host key stops the connection.
- AC6 The host bar shows who is connected for as long as they are, and ends the session in one
  click.

## Not in this epic

The relay (E62), control on macOS and Linux (E63), and access while no one is signed in to the
computer (E64, E65). The mobile app connects by pairing code only.
