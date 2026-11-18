# E107 Recovery phrases on the computer

Milestone: standalone (Security). Depends on: E48, E15, E28.

## Goal

Wherever Runova locks data with a secret the person chooses, they can let Runova make the secret
instead: 24 random words, the way a crypto wallet writes its key. The words can be copied, saved to
a file or shown as a QR code for the Runova app on a phone. Typing your own secret still works
everywhere.

## Design

- **Where:**
  - the sync key and the team key (E48)
  - the Vault master password
  - the server backup secret key (E28)
  - the core backup passphrase (E15)
  - the settings backup's environments password
  - the servers passkey
- **The words:**
  - The BIP39 English list, 24 words for 32 random bytes plus an 8-bit checksum.
  - `packages/protocol/src/phrase/phrase.ts` turns bytes into words and back, decides when typed text is a phrase, and writes and reads the QR payload.
  - It uses `@scure/bip39`, which comes from the same author as the `@noble/*` packages already used.
  - `packages/protocol/test-vectors/recovery-phrase-v1.json` pins the format for the phone core and server core.
- **Where a phrase is made:** only the main process makes one, from `crypto.randomBytes(32)` (`src/main/phrase/registry.ts`).
  - The page gets the words to show and a random 128-bit id.
  - Setting a key sends the id, never the words.
  - A phrase belongs to the window that asked for it and is kept until that page discards it, the window closes, or 15 minutes pass. A failed attempt can then be retried with the phrase already written down.
  - The bytes are zeroed when it goes.
- **One canonical form:** a recovery phrase is read as lowercase words joined by single spaces. That happens where the key is derived:
  - `deriveKey` in `src/main/crypto/aesGcm.ts`, used by sync, the Vault, the settings backup and the passkey
  - the server-backup channels, before the secret reaches the core
  - so a phrase typed with capitals, tabs or line breaks opens the same data

  Any other passphrase is used exactly as typed, so nothing set before this changes. No file or envelope format changes: a phrase goes through the same scrypt or PBKDF2 a passphrase does.
- **Recovery key:** the sync recovery key is now written as 24 words. A key in the older eight groups of seven characters still unlocks.
- **On screen** (`src/renderer/src/components/phrase/`):
  - The words and the QR code start hidden and hide again when the window loses focus.
  - While a phrase card is mounted the window has content protection, so screenshots and screen sharing show it black.
  - Copy goes through `ClipboardGuard`, which clears the clipboard after the Vault's setting (a minute when that is "never") if the phrase is still there.
  - Save writes a text file with mode 0600: what the phrase opens, the day, the numbered words and a warning.
  - The QR code is drawn in the main process as an SVG and handed over as a picture.
- **Before a key is set from a phrase,** the person picks the right word for three places out of four choices each.
  - After a typed sync passphrase, the recovery key gets the same check.
  - After a phrase, a tick is enough, since the person already has a safe copy.
- **Unlock fields:**
  - They take a phrase in 24 word boxes, with autocomplete, paste-to-fill, a live checksum and "Open a saved file".
  - Pasting 24 words into a password field opens the boxes on its own.

## Tasks

- [x] T1 Shared phrase module and test vectors in `packages/protocol`.
- [x] T2 Main process: the registry, the saved file, the `phrase:*` channels, canonical phrases in `deriveKey`, recovery keys as words.
- [x] T3 Every channel that sets one of the secrets above takes `{ phraseId }`, with tests.
- [x] T4 Renderer: phrase card, check, word boxes, the new and existing secret fields, with tests.
- [x] T5 The sync key dialog, the Vault setup, lock and change screens, the backup dialogs, the servers passkey and the settings backup use them.
- [x] T6 Server core: the admin CLI restore reads a typed phrase in its canonical form
  (`Security/RecoveryPhrase`, tested against the same vectors).

## Acceptance criteria

- AC1 Every place in the list offers "Create a phrase for me" first and "Type my own" beside it.
- AC2 A phrase is never made outside the main process, and setting a key sends only its id.
- AC3 A phrase typed with any capitals or spacing opens what it locked. A typed passphrase is used as is.
- AC4 Words and QR code are hidden until asked for, hide on blur, and are kept out of screenshots.
- AC5 Copy clears itself; the saved file reads back into the word boxes.
- AC6 An older base32 recovery key still unlocks.
