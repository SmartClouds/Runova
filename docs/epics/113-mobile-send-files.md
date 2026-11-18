# E113 Send files from the phone

Milestone: standalone (Mobile). Depends on: E112, E73 (the phone's link to the computer).

## Goal

Send photos, files and folders from the phone to your computers and to your teammates' computers,
from inside the app or from any app's Share button.

## Design

- **The same protocol as the computers.** The phone speaks E112's `send` messages and the computers'
  file transfer (`file-*` messages and 13-byte chunk frames), tested against
  `packages/protocol/test-vectors/send-v1.json`.
- **A link of its own.** A send gets its own hub session and link next to the phone's connection
  to a computer, so a send keeps going when that connection ends or the phone moves to another
  computer. The hub stays connected while a send runs.
- **Files open when they start.** Picked files are opened only when their turn comes, so a large
  pick never holds hundreds of open files.
- **The phone does not receive yet.** It registers no `receive-files` feature until E114.
- **On screen.**
  - A Send files screen: pickers for files, photos and a folder, the staged list, the computers
    to send to, a note, and the sends with their progress.
  - Android takes shares from other apps, and keeps a send going in the background with a
    progress notification.
  - iOS asks for background time while a send runs.

## Tasks

- [ ] T1 Website API: a phone may send.
- [ ] T2 Rust protocol: send and file messages, chunk frames, transfer keys, against the vectors.
- [ ] T3 Rust transfer crate: sender and receiver, with tests over a memory link.
- [ ] T4 Engine: a hub event router by session, send links of their own, the view.
- [ ] T5 Android screens, the share target, the foreground service, snapshots.
- [ ] T6 iOS, written to match.
- [ ] T7 Docs.

## Acceptance criteria

- AC1 Photos and a folder picked on the phone arrive on a computer with the same bytes and layout.
- AC2 A send keeps going when the phone's connection to a computer ends.
- AC3 A file shared from another Android app opens the Send files screen with it staged.
