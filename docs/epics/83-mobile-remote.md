# E83 Remote desktop

Milestone: standalone (Mobile). Depends on: E73.

## Goal

Control any reachable computer's screen from the phone, as the desktop app can, including computers
with only the background agent.

## Design

A second peer connection inside the link, as on the desktop, with the host offering and codecs in
its order. Video goes to MediaCodec and VideoToolbox surfaces, created on open and released on
close. JPEG tiles are the fallback and the first version. Input is normalized coordinates.

## Tasks

- [x] T1 JPEG tile path with reused bitmaps
- [x] T2 Touch, keyboard and clipboard over the control link. The `runova-input` channel comes with T3, since it lives on the video connection.
- [ ] T3 Video track and hardware decoding, on the E70 transport. Not done: there is no real device to test MediaCodec or VideoToolbox against, and tiles carry the screen without it.
- [x] T4 Password connections with CPace for computers that use them
- [x] T5 Viewer screen and toolbar on both OS. The iOS side has not been compiled.

## Acceptance criteria

- AC1 A real computer's screen is shown and controlled on both OS.
- AC2 Without a direct path, tiles carry the screen.
- AC3 An agent host works.
- AC4 Closing the viewer returns memory to the connected budget.

## Not in this epic

File transfer, and hosting from a phone.
