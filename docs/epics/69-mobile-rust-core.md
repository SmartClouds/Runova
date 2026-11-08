# E69 Rust core foundation and CI

Milestone: standalone (Mobile). Depends on: E66, E68.

## Goal

The Rust workspace builds for Android and iOS, speaks Runova's wire formats byte for byte, can sign
in and reach the hub, and is guarded by CI from the first commit.

## Design

See `docs/mobile/architecture.md` for the layout.

- `protocol` and `crypto` are checked against `packages/protocol/test-vectors/anywhere-v1.json` and
  cross-checked with `Runova.RemoteAgent.Core` as a second implementation.
- `signalr` is written by hand on tokio-tungstenite (negotiate, the JSON handshake, invocation,
  completion, ping, record separator), since no maintained crate exists. How `rd1.` tokens reach the
  socket follows the desktop's `hub.ts`.
- `api` covers PKCE and refresh rotation, with single-flight refresh and the 30 s reuse grace.
- The identity seed is generated in Rust and wrapped through a key storage callback.
- First confirm the Mac mini runner has Xcode. If it does not, the iOS job is blocked and this is
  reported.

## Tasks

- [ ] T1 Local toolchain: Rust Android targets, `cargo-ndk`, JDK 17 or later, `ANDROID_HOME`
- [ ] T2 Workspace, `ffi` crate with a pinned UniFFI, a smoke call from Kotlin and from Swift
- [ ] T3 `protocol` and `crypto` against the vectors
- [ ] T4 `signalr` against the real `RemoteHub` through the API test host
- [ ] T5 `api` with sign-in and rotation
- [ ] T6 Key storage callback
- [ ] T7 CI: Rust on Linux, Android on Linux, iOS on the Mac mini, coverage floors
- [ ] T8 The `mobile-dev` project skill with build, test and run commands

## Acceptance criteria

- AC1 All `anywhere-v1.json` vectors pass in Rust.
- AC2 A Rust client signs in against the API test host and goes through a real hub invocation.
- AC3 Reusing a rotated refresh token behaves as the server specifies.
- AC4 Kotlin and Swift each call into the core and get a typed answer.
- AC5 All three CI jobs are green on master.

## Not in this epic

WebRTC (E70) and screens (E72).
