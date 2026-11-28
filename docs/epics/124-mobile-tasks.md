# E124 Tasks on the phone

Milestone: standalone (Mobile). Depends on: E122, E123, E73 (the phone's link to the computer).

## Goal

Everything the desktop's Tasks tab does, on the phone: see the plan's progress, read and edit tasks
and their specs, handoffs, decisions, workarounds, risks and questions, split a request into tasks,
redo a part with another agent, and start or pause a relay.

## Design

- The files stay on the computer. The phone reaches them through bridge methods under a new `tasks`
  scope the person grants per phone, and never sees a path. Edits from the phone are committed by the
  computer (E123).
- Bridge methods reuse the desktop's own IPC input checks and services:
  - reads: `tasks.overview`, `tasks.board`, `tasks.detail`, `tasks.plan`, `tasks.milestones`,
    `tasks.items`, `tasks.journal`;
  - writes: `tasks.create`, `tasks.update`, `tasks.setStatus`, `tasks.toggleAcceptance`,
    `tasks.saveBody`, `tasks.reorder`, `tasks.saveItem`, `tasks.answerQuestion`, `tasks.redo`,
    `tasks.split`, `tasks.applyProposal`;
  - run control: `tasks.start`, `tasks.pause`, `tasks.resume` (danger).
- The Rust core splits task and item bodies into sections and checklists, so the phone shows them
  natively. The demo computer answers every method.
- Android and iOS get a Tasks section: Overview with milestone progress, Board and List, task detail
  and edit, the item lists, Split into tasks, Redo and run controls.

## Tasks

- [ ] T1 Protocol methods, scope and wire vectors.
- [ ] T2 Desktop bridge, with tests.
- [ ] T3 Rust view, demo answers and tests.
- [ ] T4 Android screens and snapshot tests.
- [ ] T5 iOS, written to match.
- [ ] T6 Docs.

## Acceptance criteria

- AC1 A task's status changed on the phone shows on the desktop and is committed there.
- AC2 Without the `tasks` scope the phone can not read or change the plan.

## Tests

- Bridge methods (scope checks, bad input), Rust view and demo coverage tests, Android UI tests and
  snapshots, iOS tests (unverified until CI).
