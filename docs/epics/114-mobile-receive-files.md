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

- [ ] T1 Website API: phones online, ringing a phone for a send, teams for phones, the phone list.
- [ ] T2 Rust: hub receive path, the host side of the link, the receiver, the view.
- [ ] T3 Android: the question, the received files, settings, snapshots.
- [ ] T4 iOS, written to match.
- [ ] T5 Desktop: phones in the recipient picker.
- [ ] T6 Docs.

## Acceptance criteria

- AC1 A computer sends a folder to a phone, the phone asks, and the files arrive intact.
- AC2 A phone that is closed or in the background reads as offline and is never rung.
- AC3 A teammate can send to a phone only while it is shown to a team they share.
