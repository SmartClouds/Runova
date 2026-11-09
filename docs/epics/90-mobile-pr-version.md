# E90 Pull requests and version updates on the phone

Milestone: standalone (Mobile). Depends on: E86.

## Goal

Open and review a pull request from the phone, and have the computer's AI update the version in a
project's files after a bump.

## Design

- The desktop handlers were lifted out of their IPC wrappers, so the phone and the window run the
  same code. Nothing about the desktop's own behavior changes.
- Pull request text and reviews come from the AI on the computer. The phone only gets the result and
  can edit it before anything is sent.
- Opening a pull request pushes the branch first, so the phone asks before doing it. Posting a review
  as a comment asks too. Without the GitHub CLI the computer hands back a link to finish on GitHub.
- A version update can run for minutes, so the bridge keeps a run record and the phone reads it on
  the Git section's 4 second tick. Each changed file can be put back or restored afterwards.

## Acceptance

- [x] AC1 A branch's pull request shows its state, review, checks and open threads
- [x] AC2 A missing or signed out GitHub CLI says so
- [x] AC3 The AI writes the title and body, and the result can be edited
- [x] AC4 Opening one asks first, and offers a link when the CLI can't do it
- [x] AC5 The AI reviews it, and the review can be edited and posted as a comment
- [x] AC6 Updating the version asks first, is followed live, and can be stopped
- [x] AC7 Each changed file can be undone and redone
- [ ] AC8 Tried end to end against a real computer

## State

The bridge, core and Android screens are tested, with the bridge against fakes. The iOS screens are
written to match but have never been compiled.
