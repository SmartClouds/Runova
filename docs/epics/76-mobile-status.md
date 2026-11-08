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

- [ ] T1 Bridge methods with visibility-driven subscriptions
- [ ] T2 `store` and the strip
- [ ] T3 Detail screen for all providers, with charts

## Acceptance criteria

- AC1 The strip matches the desktop's numbers for the same computer.
- AC2 A stale or unavailable provider is shown as such.
- AC3 No polling happens while the strip is off screen.

## Not in this epic

Usage alerts, which are E82.
