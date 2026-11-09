# E87 Pipeline fixes and the prompt builder on the phone

Milestone: standalone (Mobile). Depends on: E74, E80.

## Goal

Fix a failed pipeline from the phone, with an agent or with auto-fix, and write a prompt in the
Prompt Builder and send it to an agent. The work runs on the computer and the phone follows it.

## Design

`apps/desktop/src/main/remote/manage/agentMethods.ts`. Auto-fix calls the service the desktop uses,
so a session started on either side shows on both. An agent started from the phone is a normal
workspace terminal: the desktop gets a tab for it and the phone follows it with `terminals.follow`,
so its questions can be answered from either.

The prompt is written where Settings says, the default CLI or the chosen provider, from the same
template as the desktop page. Unlike that page, the phone doesn't translate the request to English
first, and it doesn't size the run afterwards, because that would spend a second CLI call.

## Acceptance

- [x] AC1 A failed run offers Fix with AI and Auto-fix, and a live run offers Auto-fix
- [x] AC2 Auto-fix shows its phase, its story so far and the agent at work
- [x] AC3 Auto-fix can be stopped, retried, committed and cleared, and what pushes asks first
- [x] AC4 Fix with AI starts an agent with the failure and opens it on the phone
- [x] AC5 The builder writes a prompt on the computer, and it can be edited, copied or sent to an agent
- [ ] AC6 Tried end to end against a real computer

## Not on the phone yet

Templates, history, scheduling and splitting into tasks in the Prompt Builder. Picking a model and
effort for an agent: it starts with the computer's own defaults.

## State

The bridge, core and Android screens are tested, with the bridge against fakes. `liveAgents.ts`, which
starts the real terminal, has only been type-checked. The iOS screens are written to match but have
never been compiled.
