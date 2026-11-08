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
- [ ] T3 Security review of the phone, the bridge and the push path
- [ ] T4 CD for signed Android and TestFlight
- [ ] T5 Version bumps in the release checklist

## Acceptance criteria

- AC1 A soak of several hours stays within budget with no growth.
- AC2 Every screen passes parity, or has a recorded reason.
- AC3 No open high-severity security finding.
- AC4 A tag produces an installable build on both OS.

## Not in this epic

Store listings and website marketing.
