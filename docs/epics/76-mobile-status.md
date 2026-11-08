# E76 Status: AI usage, CPU and RAM

Milestone: standalone (Mobile). Depends on: E73.

## Goal

The information in the desktop's status bar is on the phone: limits for Claude, Codex and Cursor,
CPU and RAM, with a detail screen for every provider.

## Design

A strip like the desktop status bar, using its `LimitChip` states (`ok`, `estimate`, `stale`,
`unavailable`). Methods wrap `usage:*` and `system:*`. Usage refreshes every 60 s and the system
sample every 4 s, and only while visible.

## Tasks

- [x] T1 Bridge methods with visibility-driven subscriptions
- [x] T2 `store` and the strip
- [x] T3 Detail screen for all providers, with charts

## Acceptance criteria

- AC1 The strip matches the desktop's numbers for the same computer.
- AC2 A stale or unavailable provider is shown as such.
- AC3 No polling happens while the strip is off screen.

## Not in this epic

Usage alerts, which are E82.

## Status

The bridge, the core and the Android screens are tested, and the desktop and a phone share one
system reading so the CPU figures stay steady. Only limits, CPU, memory and network are here so far:
the bar's Relay, Run, SFTP, Docker, Android and Keep awake items are not on the phone. Owed: AC1 on a
real computer, and the iOS screens have never been compiled.
