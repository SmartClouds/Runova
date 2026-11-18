# E112 Send files between computers

Milestone: standalone (Connect). Depends on: E60, E61, E62, E67 (Runova Anywhere).

## Goal

Send files and folders to your other computers and to your teammates' computers, live, the way
TeamViewer or AnyDesk do it. Pick the files, pick a computer, press Send. The person at the other
end sees who is sending what and says yes or no, and both sides watch the files arrive.

## Design

- **A new `send` intent on the hub.** The sender asks the website to ring the other computer with
  intent `send`. The receiving app answers the ring by its own rules (who may send it files) and
  the two open the same encrypted link Anywhere already uses. The file names, sizes and the note
  then go over that link in a `send-offer`, so the website never learns what is sent. Only then
  does the person at the other end see "Ali wants to send you 35 files" and accept or decline.
- **The website stores nothing.** It only passes things on: the ring, the signaling and the
  relay's sealed frames. A send leaves no session record, and what an app can do is never written
  down. The app says it as it goes online (`GoOnlineWithFeatures`), the hub keeps it with the
  presence in memory, and it goes when the app does.
- **Older apps are safe.** An older Runova reads an intent it does not know as `control`. So the
  hub rings only an app that went online with `receive-files`, and the directory and presence
  changes carry what each online app said, so an older computer reads "Needs a newer Runova". A
  website from before this epic has no `GoOnlineWithFeatures`; the app then goes online the old
  way and Anywhere keeps working.
- **Every send is a session of its own.** A send has its own hub session, link and transfer engine,
  apart from the single control connection, so you can send to two people while you control a
  third computer. Both sides end the hub session when the link or the batch ends.
- **The receiver owns its disk.**
  - Each side takes only the messages of its role. The sender refuses offers and file requests;
    the receiver refuses file requests.
  - Every file is checked against the accepted list (id, name, size, part size).
  - A folder's paths go through `safeRelativePath` and `targetFor`, so nothing lands outside the
    chosen folder.
  - Part files sit in a hidden `.runova-partial` folder inside the save folder, and a file that
    can not be moved into place fails instead of reading as verified.
- **Right on a slow link.**
  - The sender reads the whole file again for its final hash, so a resume can not spoil it.
  - Frames wait while more than 2 MiB is still queued on the link, and a part's ack timer starts
    once the part has left.
  - Sends use 4 MiB parts, and up to 4 files move at once so small files do not wait on round
    trips.
- **Resume.**
  - The link carries a ping every 10 seconds, and 20 silent seconds count as a drop.
  - The sender then dials the same batch again for 5 minutes (1, 2, 4, 8 and 15 seconds apart).
  - The receiver knows the batch by its id and the sender's key, does not ask again, and answers
    with the files it already has so none is saved twice.
- **Who may send.** In the Anywhere settings:
  - `receiveFrom`: everyone (my devices and teammates), only my devices, or no one;
  - `autoAcceptOwn`: files from my own devices go straight in;
  - `saveFolder`: Downloads unless changed.

  Teammates reach a computer while it is shown to a team they share, as for connecting.
- **On screen.**
  - A **Send files** tab on the Remote page: a drop zone, the staged files and folders, the
    devices to send to, an optional note and one Send button.
  - A **Sent and received** card in the Remote page's rail.
  - An **Incoming files** window that stays on top.
  - A status bar item, a Send files button on every device on the Anywhere tab, toasts and
    notifications.

## Tasks

- [x] T1 `packages/protocol`: the send messages, limits, path rules and `send-v1.json` vectors.
- [x] T2 Website API: the `send` intent, what an online app can do (in memory), no record of a send, tests.
- [x] T3 `FileTransferManager`: role allowlist, accept hook, drain gating, hash from disk, part
  files beside the target, finished ids, cleanup.
- [x] T4 Links: queued bytes and `drain` on `SecureLink`; a failed data channel send closes the link.
- [x] T5 The manifest of files and folders.
- [x] T6 Outgoing and incoming batches, with speed and time left.
- [x] T7 Anywhere service: dialing for a send, serving one, `decideSend`, the receive settings.
- [x] T8 The send service.
- [x] T9 IPC, the incoming files window, the quit question and keep awake.
- [x] T10 Renderer: the Send files tab, the rail card, the incoming window, the status bar item,
  the Anywhere buttons and settings.
- [x] T11 e2e, the help article and docs.

## Acceptance criteria

- AC1 A folder and a large file sent from one computer arrive on the other with the same bytes and
  layout, after the person there accepts.
- AC2 A send to someone who declines, does not answer, or takes no files says which of those it was.
- AC3 Pulling the network in the middle of a file resumes it, and it ends with one verified copy.
- AC4 A send can not write outside the folder the receiver chose, and can not read any file the
  sender did not pick.
- AC5 An older computer shows "Needs a newer Runova" and is never rung for a send.

## Implementation notes

- **Protocol.** `packages/protocol/src/send.ts`: `send-offer`, `send-answer`, `send-cancel`,
  `send-ping`, `send-complete`, the limits (10,000 files, a 4 MiB offer, a 500-character note,
  1,024-character paths of up to 32 parts), and `safeRelativePath`. An offer with two files that
  would land on the same name, or share a chunk key, is turned down. `send-v1.json` pins the
  messages, the path rules, the FNV-1a transfer keys over UTF-16 and a chunk frame for the phone.
- **Website.** `RemoteHub.GoOnlineWithFeatures` keeps what an app can do in `RemotePresence`, in
  memory; `PresenceChanged` and the directory carry it. `RequestConnect` with `send` checks the
  relation, ask mode and an app sender (`RemoteAccess.MaySend`), then that the target's app is
  online and said `receive-files`; an agent alone answers offline. `Connected` records nothing for
  a send. No table or column changed.
- **Engine.** `FileTransferManager` options: `role`, `acceptOffer` (folder, part folder and saved
  name), `partBytes`, `reconnectAbandonMs`, `forgetAfterMs`, plus `flushed` and `dispose`. Fixed
  for every transfer: frames that arrive faster than they are written keep their order, the final
  hash is read from the file, a failed move fails the file, a re-offered finished file gets its
  receipt instead of a second copy, and an offer whose part count does not fit its size is turned
  down.
- **Links.** `SecureLink.drain`; the WebRTC transport counts what it handed the renderer since the
  last report; a refused data channel send closes the link.
- **Desktop.** `main/remote/send/`: `manifest.ts`, `batch.ts` (inbox, keepalive, outgoing and
  incoming batches), `rate.ts`, `service.ts`, `window.ts`, `active.ts`, `live.ts`. The Anywhere
  service dials sends apart from its single control slot (`dial`), serves them through `deps.send`,
  ends the hub session whenever a send link closes, and leaves a live send link alone when the hub
  forgets its session. Receive settings live in `anywhere.json`; the save folder is set only through
  the folder picker.
- **Screens.** `components/remote/send/`: `SendPanel`, `SendComposer`, `SendDropZone`,
  `RecipientPicker`, `ReceiveSettingsCard`, `SendTransfersCard`, `BatchRow`, `RunwayProgress`,
  `IncomingFilesRoute`, `FileSendToasts`, and `layout/FileSendSegment`. A section in the Access
  settings dialog, and a Send files button and drop target on every Anywhere device row.

## Status

Complete on the desktop and the website API, tested against simulated computers and the real API.
Real computers can send to each other only once the website API is deployed; until then the app
goes online the old way and devices read "Waiting on a website update".
