# E73 Slice: sign in, systems, connect, projects

Milestone: standalone (Mobile). Depends on: E71, E72.

## Goal

A person signs in on the phone, sees their computers, connects to one, and sees its projects. This
proves every layer before any feature screen is built.

## Design

Sign-in uses the system browser with PKCE. Systems come from `/reachable-devices` with live presence
over the hub. Connecting runs the E70 link. The first connection asks for approval at the computer;
later ones go straight in. Backgrounding closes the link after 30 s and returning reopens it.

## Tasks

- [ ] T1 `store` for sign-in, systems, connection and projects
- [ ] T2 Screens on both OS with fixtures
- [ ] T3 Approve-once flow on the phone, showing the safety code
- [ ] T4 Reconnect and resubscribe
- [ ] T5 Maestro flows against a fake host, on both OS

## Acceptance criteria

- AC1 Sign in, see the computers with correct online state, connect, see projects, on both OS.
- AC2 A first connection waits for approval and a later one does not.
- AC3 Leaving the app for a minute and coming back restores the screen without a prompt.
- AC4 Connected and idle stays within the memory budget.

## Not in this epic

Project contents, which arrive with E74 onward.
