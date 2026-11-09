# E85 Studio on the phone

Milestone: standalone (Mobile). Depends on: E71, E72.

## Goal

Make a video from the phone: browse the library, start one from a sentence, watch the AI work, ask
for changes, animate the scenes and render the film. All of it runs on the computer.

## Design

A new `studio` scope on the bridge, in `apps/desktop/src/main/remote/manage/studioMethods.ts`. It
calls the same Studio service the windows do, so the phone and the desktop see one video.

- The bridge sends titles, scenes and progress, and never a path.
- The service gains `hold` and `release`, so a phone reading a video doesn't take it away from the
  editor and the editor closing doesn't take it from the phone. A phone that goes quiet lets go
  after 45 seconds.
- "Animate every scene" is a queue on the computer, so it carries on with the phone locked. A scene
  that fails stops the queue and says so.
- A running CLI's last six lines are kept on the computer for the phone to read on its tick.
- Pictures travel outside the view, because the view is copied to native code on every change. The
  core keeps the last 40.

## Acceptance

- [x] AC1 The library lists videos with the state of their latest render
- [x] AC2 A new video starts from a prompt, shape, length, look and language, and opens on its run
- [x] AC3 The video shows its steps, scenes, the live run with its last lines, and can stop the run
- [x] AC4 Ask AI returns a before and after proposal to apply or discard
- [x] AC5 One scene or all of them can be animated, and all of them asks first
- [x] AC6 Render picks a quality, shows the estimate or why it can't start, shows progress and stops
- [x] AC7 A phone without the Studio scope is told how to turn it on
- [ ] AC8 Tried end to end against a real computer

## Not on the phone yet

Voice, the timeline, pictures, and fetching the finished file. The file stays on the computer and
the phone says so. Scene previews are still pictures, because a preview is a local page on the
computer.

## State

The service, bridge, core and Android screens are tested, with the bridge against a fake service.
The iOS screens are written to match but have never been compiled.
