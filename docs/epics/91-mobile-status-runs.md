# E91 Runs and Relay plans in the phone's status

Milestone: standalone (Mobile). Depends on: E76.

## Goal

Show the two status bar items the phone was missing: what each project run is doing, and Relay plans
running in the background or waiting to be reviewed.

## Design

- Runs and plans live in the window, so main can't work them out alone. The status bar publishes them
  to main, only when something changes.
- Main forgets them when the window closes or reloads, so the phone is never shown a stale run. With
  no window open the phone says so, rather than showing nothing.
- A plan goes out with the time gone by, not a start time, because the two clocks can differ.
- A plan's brief and its result stay on the computer. Only the kind, project name and status go out.

## Acceptance

- [x] AC1 Each run shows its state, CPU, memory, first address and device
- [x] AC2 Each plan counts up while running, and asks for attention when done or failed
- [x] AC3 They sit in the same place in the list as on the desktop's bar
- [x] AC4 With no window open the phone explains why they're missing
- [x] AC5 A computer too old to report them shows no false hint
- [ ] AC6 Tried end to end against a real computer

## State

The feed, bridge, core and Android screen are tested. The iOS change is written to match but has never
been compiled.
