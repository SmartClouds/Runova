# E106 App lock on the phone

Milestone: standalone (Mobile). Depends on: E77.

## Goal

A passcode that locks the whole phone app, as Telegram's does: a 4-digit code, a 6-digit code or a
password, opened with Face ID, Touch ID or a fingerprint instead when the user wants, locked again
after a chosen time in the background.

## Design

- The rules live in the Rust core (`crates/ffi/src/app_lock`). `mod.rs` holds them with no I/O,
  so the keypad, setup, waits and auto-lock are tested without a clock. `runner.rs` connects them to
  the engine: the secure store, lifecycle, biometrics and the intents native code sends.
- The passcode is kept as an scrypt hash (`crates/crypto/src/passcode.rs`): N = 2^15, r = 8, p = 1,
  a fresh 16-byte salt, NFKC first, compared in constant time. Only the parameters this app writes
  are accepted, so a planted value can't make a check slow or weak. The code itself is never
  stored and never leaves the core. Checks run off the engine's task.
- Two secure store keys: `app-lock` (the kind, hash, auto-lock and biometric choice) and
  `app-lock-tries` (wrong codes in a row and when the wait ends, on the wall clock, so killing
  the app does not end a wait). A restored wait is capped at an hour, in case the clock moved.
- Four wrong codes are free. Then each wait grows: 30 s, 1 min, 5 min, 15 min, then an hour each
  time. Codes typed during a wait are not looked at. The countdown ticks once a second.
- A cold start with a passcode set is locked from the first view the core publishes. Auto-lock
  choices are Right away, 1 minute (the default), 5 minutes, 1 hour and 5 hours. Right away locks
  as the app leaves the screen. The others lock when it comes back after that long.
- Native code reports what the phone can check before each `Foregrounded`: the kind, its name and
  an enrollment token. Android's token comes from a Keystore key made with
  `setInvalidatedByBiometricEnrollment`. iOS uses `evaluatedPolicyDomainState`. A different token
  means a face or finger was added, so biometric unlock turns off until the passcode is entered and
  it is turned on again.
- Biometrics are offered once each time the lock screen comes up, and again from the key beside
  the 0. The prompt allows biometrics only, never the phone's own PIN, so that PIN can't open what
  the app's passcode guards. Answers go through the existing `biometric_result`, checked by id.
- While locked, only the lock screen is drawn, so nothing behind it reaches the screen or a screen
  reader. Locking drops any Vault or Cloudflare check that was waiting. With a passcode set, the app
  is hidden in the app switcher (`setRecentsScreenshotEnabled(false)` on Android 13 and later,
  `FLAG_SECURE` before that, and a cover on iOS).
- "Forgot passcode?" asks first, then signs the phone out fully and removes the lock. Any sign-out
  that clears the identity removes the lock too.
- Settings: Account, Security, Passcode lock. With a passcode set, the current code is needed
  before the settings show: biometric unlock, auto-lock, change the code (keeping the other
  choices), lock now, and turn it off.

## Tasks

- [x] T1 Passcode hash in the crypto crate, with tests.
- [x] T2 Rust: the lock rules with unit tests, the engine wiring with integration tests.
- [x] T3 Android: lock screen, settings, biometric prompt and enrollment check, with Compose tests,
  snapshots and a real-core bridge test.
- [x] T4 iOS, written to match, with snapshot and bridge tests.
- [x] T5 Fingerprint, face and backspace icons added to the icon font.

## Acceptance criteria

- AC1 A 4-digit code, a 6-digit code or a password can be set, asked for twice, changed and turned
  off. The store holds a hash, never the code.
- AC2 A cold start with a passcode set shows nothing but the lock until it is opened.
- AC3 Wrong codes shake the dots. From the fifth, a wait grows, survives a restart and counts down.
- AC4 Face ID, Touch ID or a fingerprint opens the lock when turned on, and turns itself off when a
  face or finger is added.
- AC5 The app locks after the chosen time away, or right away, and on Lock now.
- AC6 "Forgot passcode?" signs the phone out after asking, and the lock goes with it.

## Status

Rust core and Android are tested. iOS is written to match but not compiled yet (needs the Mobile
iOS CI job).
