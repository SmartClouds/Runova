# E114 Receive files on the phone

Milestone: standalone (Mobile). Depends on: E112, E113.

## Goal

Computers and phones can send files to a phone while Runova is open on it. The phone asks first,
shows the files arriving, and keeps them where the person can open, share or save them.

## Design

- **The phone is reachable while it is open.**
  - The phone goes online on the hub while the app is in front, or while it receives, and
    offline once it has been in the background for a while.
  - The hub rings a phone only for a send.
- **A separate list.** The directory lists phones on their own (`phones`), so older apps never
  offer to connect to one.
- **Teammates.** A phone can be shown to teams, which means its teammates may send it files.
- **The phone as the host.** The Rust core already has the host's half of the handshake, the
  answering side of WebRTC and the relay. This epic uses them for real: it answers the ring,
  waits for the computer's offer or its relay signal, proves itself and receives.
- **Where files go.**
  - Android keeps them in the app's own folder, with Open, Share and Save to Downloads.
  - iOS keeps them in Documents/Received, which shows in the Files app.
- **Computers.** The Send files tab lists phones with a phone icon; one that is offline reads
  "Open Runova on the phone to receive".

## Tasks

- [x] T1 Website API: phones online, ringing a phone for a send, teams for phones, the phone list.
- [x] T2 Rust: hub receive path, the host side of the link, the receiver, the view.
- [x] T3 Android: the question, the received files, settings, snapshots.
- [x] T4 iOS, written to match.
- [x] T5 Desktop: phones in the recipient picker.
- [x] T6 Docs.

## Acceptance criteria

- AC1 A computer sends a folder to a phone, the phone asks, and the files arrive intact.
- AC2 A phone that is closed or in the background reads as offline and is never rung.
- AC3 A teammate can send to a phone only while it is shown to a team they share.

## Implementation notes

Two changes from the design above, both to keep to the rule that the website stores nothing for
sends and only passes them on:

- **Own devices only.** Teams for phones would be a new stored setting, so a phone takes files
  only from its owner's own computers and phones. The hub refuses a teammate's send to a phone,
  the teammates query leaves phones out, and AC3 is met by refusing every teammate. A later epic
  can add teams for phones if that is wanted.
- **Relay only on the phone's side.** The phone answers the ring and at once tells the computer to
  use the relay (`{"k":"relay"}`, as the background agent does), then meets it there as the host,
  sealed. The desktop already switches to the relay on that word, even before its link opens. The
  phone's own WebRTC answerer is left for later.

The rest:

- **Server.** `GoOnlineWithFeatures` takes a phone that says `receive-files` (plain `GoOnline`
  still refuses one) and writes nothing for it; `RequestConnect` finds a phone only for a `send`
  and only from its owner; `/reachable-devices` lists the owner's phones under `phones`. Tests in
  `RemotePhoneReceiveTests`.
- **Session.** `HubEvent::Incoming`, `HubPort::respond` and `go_online` (with defaults, so other
  hubs need no change), and `accept_send`, which signals the relay word, takes a relay ticket and
  runs `SecureLink::as_host` against the key the hub named.
- **Transfer.** `wait_for_answer` keeps pinging while the person decides, so the computer does not
  take the quiet link for a dropped one, and notices the computer giving up.
- **Engine** (`ffi/src/receive.rs`). Goes online once the app gives a folder, says no on the hub to
  anything but an own `send` (or when switched off, or with two coming in), asks the person unless
  "Accept from my computers without asking" is on, and keeps what a dropped send received by batch
  and sender key for 7 minutes, so the computer's next dial picks up without asking again. The hub
  stays up in the background while anything comes in.
- **Desktop.** Phones come from `directory.phones` (empty from an older website) and show among my
  devices; a closed one reads "Open Runova on the phone". Presence moves phone rows too.
- **Android.** `ui/Receive.kt`: the question as a sheet over any screen, received files with Open
  and Share through the `FileProvider`, and the receiving settings. Files go to the app's own
  `Received` folder; the foreground service covers receives.
- **iOS.** `UI/Receive.swift`: the same, with Quick Look and `ShareLink`; files go to
  `Documents/Received`, shown in the Files app (`UIFileSharingEnabled`,
  `LSSupportsOpeningDocumentsInPlace`). Not compiled here.

## Status

Complete. Evidence: website `RemotePhoneReceiveTests` (6) with the Remote and OpenAPI integration
tests and the unit tests; `cargo test --jobs 2` (session host cases, transfer answer waits, ffi
`receive` 9), clippy and fmt clean; Android `ReceiveTest` (6) with snapshots `receive-offer`,
`receive-offer-light`, `receive-list`, the full JVM suite and `assembleDebug`; desktop send service,
Anywhere service and recipient picker cases. iOS unverified until CI runs after a push.
