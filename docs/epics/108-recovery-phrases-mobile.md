# E108 Recovery phrases on the phone

Milestone: standalone (Mobile). Depends on: E107, E106.

## Goal

The QR code a computer shows for a recovery phrase (E107) can be scanned with the Runova app. The
phone keeps the phrase behind its own lock, shows the words only after Face ID, Touch ID, a
fingerprint or the phone's passcode, and can copy them, save them to a file, show them as a QR code
again, or use a Vault phrase to unlock the Vault on the connected computer.

## Design

- **Reading a phrase** (`crates/crypto/src/phrase.rs`):
  - It reads 24 BIP39 English words, with a hand-written decoder and the list embedded. No new dependencies.
  - It reads both Runova's `RUNOVA-PHRASE:1:<purpose>:<label>:<words>` code and a code of just the words.
  - A wrong checksum is refused.
  - It replays `packages/protocol/test-vectors/recovery-phrase-v1.json` like the desktop and the server core.
- **The rules** (`crates/ffi/src/recovery_phrases.rs`):
  - Each phrase is one secure store item, `recovery-phrase.<id>`, in the Keystore or Keychain.
  - `recovery-phrases` keeps only names, what the phrase opens and when it was scanned.
  - A phrase already kept is not kept twice.
- **Showing the words:**
  - The words reach the view only after the phone's check (`biometric_result`, shared with the Vault and Cloudflare).
  - They are never in a debug print, and they are zeroed when the view moves on.
  - Leaving the app hides them. On Android the screen gets `FLAG_SECURE`; on iOS the app switcher shows a cover.
- **Copy:**
  - On Android the clip is marked `EXTRA_IS_SENSITIVE` and cleared after a minute if it is still the phrase.
  - On iOS the pasteboard item is local only and expires after a minute.
- **Save:**
  - Android writes through the system's Create document picker.
  - iOS writes a protected temporary file, offers it in the share sheet (which includes Save to Files), and removes it when the sheet closes.
- **The QR code** is drawn on the phone: zxing on Android, Core Image on iOS.
- **Deleting** asks first. A full sign-out, including "Forgot passcode?", forgets every phrase.
- **Where:** Account, then Security, then Recovery phrases.

## Tasks

- [x] T1 Rust: phrase reading in the crypto crate, tested against the shared vectors.
- [x] T2 Rust: keeping, showing, deleting and using phrases, with engine tests.
- [x] T3 Android: the screen, sensitive copy, save, `FLAG_SECURE`, with Compose tests and snapshots.
- [x] T4 iOS, written to match, with tests. Not compiled on a Mac yet.

## Acceptance criteria

- AC1 A code from the computer is kept under its name; anything else is refused with a message.
- AC2 The words show only after the phone's check and hide when the app leaves the screen.
- AC3 Copy clears itself, save asks where, and the QR code drawn here reads back as the phrase.
- AC4 A Vault phrase unlocks the Vault on the connected computer without typing.
- AC5 A full sign-out leaves no phrase in the secure store.
