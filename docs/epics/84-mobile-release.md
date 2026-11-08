# E84 Hardening and release

Milestone: standalone (Mobile). Depends on: E74 to E83.

## Goal

The app is measured, reviewed and shippable from CD on both OS.

## Design

A new bundle id replaces `com.runova.remote`, whose APK was signed with a debug key. Android gets a
real keystore in CD secrets. iOS goes to TestFlight.

## Tasks

- [ ] T1 Memory soak on both OS against the budgets
- [ ] T2 Parity sweep over every screen
- [x] T3 Security review of the phone, the bridge and the push path
- [x] T4 CD for signed Android and TestFlight
- [x] T5 Version bumps in the release checklist

## Acceptance criteria

- AC1 A soak of several hours stays within budget with no growth.
- AC2 Every screen passes parity, or has a recorded reason.
- AC3 No open high-severity security finding.
- AC4 A tag produces an installable build on both OS.

## Not in this epic

Store listings and website marketing.

## Status

T3: an independent review of the phone, the bridge and the push path found nothing of high severity. Its
medium findings are fixed: a phone can only read files git lists as new, approval shows a code to compare
and needs a deliberate press, and signing out or switching off access ends phone sessions. Still open by
choice: a trusted phone connecting shows no desktop notification, and terminal access stays on by default
at approval. The WebRTC transports and the server's PKCE exchange were not reviewed.

T4 and T5: `cd-mobile.yml` builds from the tag, and the version comes from the tag too. It has never run,
and needs the secrets in `docs/mobile/release.md`.

T1 and T2 need real phones and a Mac, so they are open, as are AC1, AC2 and AC4.
