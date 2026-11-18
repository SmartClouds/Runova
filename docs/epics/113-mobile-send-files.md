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

- [x] T1 Website API: a phone may send.
- [x] T2 Rust protocol: send and file messages, chunk frames, transfer keys, against the vectors.
- [x] T3 Rust transfer crate: sender and receiver, with tests over a memory link.
- [x] T4 Engine: a hub event router by session, send links of their own, the view.
- [x] T5 Android screens, the share target, the foreground service, snapshots.
- [x] T6 iOS, written to match.
- [x] T7 Docs.

## Acceptance criteria

- AC1 Photos and a folder picked on the phone arrive on a computer with the same bytes and layout.
- AC2 A send keeps going when the phone's connection to a computer ends.
- AC3 A file shared from another Android app opens the Send files screen with it staged.

## Implementation notes

- **Server.** `RemoteAccess.MaySend` takes a phone as well as an app. Nothing new is stored: the
  rule is in code and the phone still registers no feature.
- **Protocol** (`crates/protocol`). `send.rs` and `file.rs` read and write the same JSON and the
  same 13-byte chunk frames as the desktop, byte for byte against `send-v1.json`, with the same
  limits, the same `safeRelativePath` rules and FNV-1a over UTF-16 units for transfer keys.
- **Transfer** (`crates/transfer`, new). A sender and a receiver over one `SecureLink`, both
  stop-and-wait per part as the desktop's receiver expects. The `Wire` pings every 10 s and calls a
  link silent for 20 s dropped. The whole-file hash is read again from the file on the blocking
  pool. The receiver keeps part files under `.runova-partial`, checks every offer against the
  accepted list, names a clash `name (1).ext`, and removes the empty part folder when the batch
  ends. It is in place now for E114.
- **Engine** (`ffi/src/send.rs`). Each send is a job with its own dial (`connect_send`,
  `Intent::Send`) beside the `connecting` slot, so `end_connection` leaves it alone. Hub events are
  handed to every dial still waiting, and each keeps its own session's, so an answer that arrives
  before `RequestConnect` returns is not lost. The runner decides redials (1, 2, 4, 8, 15 s, for 5
  minutes) so each try uses the current hub. A stop during a dial ends the session the dial got.
  The hub stays up past the background grace while a send runs. Progress reaches the view at most
  4 times a second per send. Files are read through the native `PickedFiles` callback, opened on
  the first read and closed when the file is done.
- **Wording in Rust.** The status line, `file_size_label`, `files_summary` and
  `send_button_label` come from the core, so both apps say what the desktop says.
- **Android.** `ui/Send.kt` (Send files screen, runway progress, Systems tab button and strip),
  `SendFiles.kt` (`PickedUris` over `openFileDescriptor` and a positioned `FileChannel`, folders
  walked with `DocumentsContract`, the `dataSync` foreground service), the share target for
  `SEND` and `SEND_MULTIPLE`.
- **iOS.** `UI/Send.swift` and `SendFiles.swift`: `fileImporter` for files and a folder,
  `PhotosPicker` with each item copied into the app's temporary folder, security-scoped reads
  through `FileHandle`, and `beginBackgroundTask` while a send runs. Not compiled here; it waits
  for the Mobile iOS CI job.

## Status

Complete. Evidence: `cargo test --jobs 2` (protocol `send` 12, transfer loopback 12, session
send cases, ffi `send` 16), clippy and fmt clean; Android `SendTest` 12 with four new snapshots
(`send-empty`, `send-ready`, `send-progress`, `send-progress-light`) and the Systems snapshots
re-recorded for the new button; `assembleDebug`; website `RemoteAccessTests` and the Remote
integration tests. iOS unverified until CI runs after a push.
