# E81 Account, sessions and teams

Milestone: standalone (Mobile). Depends on: E73.

## Goal

Manage the account from the phone, directly against the server.

## Design

Uses the existing `/api/v1` endpoints in `docs/website/api-contract.md`. Ending all other sessions
needs step-up, as on the website.

## Tasks

- [x] T1 `api` methods for profile, sessions, activities, teams and invitations
- [x] T2 `store` and screens
- [x] T3 Trusted computers list: forget this phone on a computer

## Acceptance criteria

- AC1 Active sessions are listed with the current one marked, and ending one really ends it.
- AC2 Ending all others asks for step-up.
- AC3 Team members and invitations work according to role.
- AC4 Sign-out clears tokens and the identity from the phone.

## Not in this epic

Billing.

## Status

The core and the Android screens are tested against a scripted server. The phone can leave a computer's
trusted list from More while connected to it.  Owed: a real
account, and the iOS screens have never been compiled.
