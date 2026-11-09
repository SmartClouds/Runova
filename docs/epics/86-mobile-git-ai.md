# E86 Tags and AI suggestions in Git on the phone

Milestone: standalone (Mobile). Depends on: E75.

## Goal

Tag a version from the phone, and use the desktop's AI help in Git. The CLI runs on the computer and
the answer shows on the phone.

## Design

The tag and AI handlers in `ipc/git.ts` are plain functions now, so the windows and the phone call
the same code. The CLI, its style rules and its fallback are whatever the computer has set.

## Acceptance

- [x] AC1 The tag screen shows the latest tag, commits since it, and the next patch, minor and major
- [x] AC2 Suggest with AI fills in the tag and notes and says why
- [x] AC3 A tag is created with or without pushing, and pushing asks first
- [x] AC4 Commit messages and branch names can be suggested, and the request can be stopped
- [x] AC5 A conflicted file can go to the AI, which asks first, and the file goes back if it fails
- [ ] AC6 Tried end to end against a real computer

## Not on the phone yet

Updating the version in files after a bump, pre-release channels, deleting tags, and PR text and
review (the bridge has no pull request methods yet).

## State

The bridge, core and Android screens are tested. The iOS screens are written to match but have never
been compiled.
