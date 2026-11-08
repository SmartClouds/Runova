# E74 Terminals and processes

Milestone: standalone (Mobile). Depends on: E73.

## Goal

See the CLIs running on a computer, open one, read it live, send it commands, and see its processes.

## Design

The bridge uses `createTerminalSession({attachOnly})` with the real `shell` and no `cols` or `rows`,
so a phone never resizes the desktop PTY. `term` parses VT output into a capped grid and native code
only draws it. The grid scales to fit and pans. Agent status comes from `agents:*`, and process
usage from `terminal:usage`, polled only while visible.

## Tasks

- [x] T1 Terminal methods and output subscription on the bridge
- [x] T2 `term`: VT parsing, 2000 line cap, styled runs for each row, coalesced to about 20 frames a second
- [x] T3 Grid renderer on both OS at the desktop's terminal colors
- [x] T4 Input bar with control keys
- [x] T5 CLI list with status, and the process view

## Acceptance criteria

- AC1 Output on the desktop appears on the phone live; a command sent from the phone runs.
- AC2 The desktop tab's size never changes because of a phone.
- AC3 Heavy output stays within the memory budget and does not stall the app.
- AC4 A CLI needing input shows that state.

## Not in this epic

Editing files.

## Status

The bridge, the `term` grid and the Android screens are tested. Owed: AC1 and AC3 on a real computer
and phone, and the iOS screens have never been compiled.
