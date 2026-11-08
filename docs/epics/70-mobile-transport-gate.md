# E70 Transport gate

Milestone: standalone (Mobile). Depends on: E69. **Go or no-go: the result is reported to the owner
before any later epic starts.**

## Goal

Prove that a phone can open a real Runova link, peer to peer first and through the relay otherwise,
against real hosts on real devices.

## Design

- Candidate: `str0m`, with no threads of its own and a small footprint. Its docs say peer to peer has
  had less testing than server use, so this is an experiment and not an assumption.
- Fallback if it fails: native libwebrtc driven from Kotlin and Swift behind the same
  `PeerTransport` trait, with Rust keeping signaling, handshake and RPC.
- Later epics depend only on the trait.
- `link` reproduces the desktop's timing: give up on direct at 8 s, send `{"k":"relay"}`, open the
  relay with a one-time ticket, and seal frames after the handshake.

## Tasks

- [ ] T1 `PeerTransport` trait and the `link` state machine against a fake transport
- [ ] T2 `str0m` behind the trait: `runova-link`, signed fingerprints, handshake
- [ ] T3 Relay path with the frame cipher
- [ ] T4 Interop test against the real desktop host (Chromium) and the C# agent
- [ ] T5 Run on a real Android phone and a real iPhone, on Wi-Fi and on mobile data
- [ ] T6 Write down the numbers and the decision in `docs/DELIVERY_STATUS.md`

## Acceptance criteria

- AC1 `hs-hello`, `hs-reply` and `hs-finish` complete against the desktop host over a direct link.
- AC2 With direct blocked, the link is up through the relay within the desktop's timing.
- AC3 The same against the C# agent.
- AC4 The chosen transport's added memory on each OS is measured and recorded.

## Not in this epic

Video, which is E83.
