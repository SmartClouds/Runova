# E89 Voice, timeline and download in Studio on the phone

Milestone: standalone (Mobile). Depends on: E85.

## Goal

Give a video a voice, adjust its timeline, and bring the finished file to the phone.

## Design

- Voice: the phone shows an estimate, and the bridge recomputes it and refuses a price the person
  didn't see. An online voice with no known price needs an explicit yes.
- Timeline: the bridge takes named gestures (move, trim, set, remove) and builds the edit with
  Studio's own rules, never a raw edit. Each lands only on the version the phone was looking at, and
  a locked track is refused.
- Download: the phone pulls 512 KiB at a time, so neither end can be overrun. The path comes from the
  render record and never leaves the computer. A partial file resumes.

## Acceptance

- [x] AC1 Voice shows engines, voices and a price, speaks silent scenes, and can be stopped
- [x] AC2 Voiced scenes are marked and can get captions
- [x] AC3 The timeline shows tracks and clips where they sit
- [x] AC4 A clip can be moved, trimmed, faded, set in volume or deleted, and a track muted
- [x] AC5 Music already in the video can be added
- [x] AC6 A finished video comes to the phone, resumes, and can be shared or saved
- [ ] AC7 Tried end to end against a real computer

## Not on the phone yet

Listening to a voice sample, recording from the phone's microphone, voice cloning, importing new
media, splitting clips, and playing a preview.

## State

The bridge, core and Android screens are tested, with the bridge against fakes. Reading a real file
and the Android and iOS share sheets have not been exercised. The iOS screens are written to match
but have never been compiled.
