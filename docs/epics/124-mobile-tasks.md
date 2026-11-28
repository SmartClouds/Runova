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
- Bridge methods reuse the desktop's own writers and services:
  - reads: `tasks.overview` (the plan, progress, milestones, what needs you, the run),
    `tasks.board`, `tasks.detail` (spec, criteria, handoff and journal) and `tasks.items` (records
    of one kind);
  - writes: `tasks.create`, `tasks.update`, `tasks.setStatus`, `tasks.toggleAcceptance`,
    `tasks.saveBody`, `tasks.saveItem` (which also answers a question), `tasks.applyProposal` and
    `tasks.redo`;
  - planning: `tasks.split`, `tasks.cancelSplit`;
  - run control: `tasks.start`, `tasks.pause`, `tasks.resume`.
- The phone gets views built on the computer (sections, checklists, fields as label and value), so
  it needs no Markdown parser. The demo computer answers every method.
- Android and iOS get a Tasks section under More: Overview with milestone progress and run
  controls, the task list with a new-task field, the task on its own screen (status moves, criteria,
  spec, handoff, journal, edit, redo), the records by kind, and Split into tasks.
- Left on the desktop: reordering tasks, editing a whole spec in Markdown and the roadmap view.

## Tasks

- [x] T1 Protocol methods, scope and wire vectors.
- [x] T2 Desktop bridge, with tests.
- [x] T3 Rust view, demo answers and tests.
- [x] T4 Android screens and snapshot tests.
- [x] T5 iOS, written to match.
- [x] T6 Docs.

## Acceptance criteria

- AC1 A task's status changed on the phone shows on the desktop and is committed there.
- AC2 Without the `tasks` scope the phone can not read or change the plan.

## Tests

- Bridge methods (scope checks, bad input), Rust view and demo coverage tests, Android UI tests and
  snapshots, iOS tests (unverified until CI).

## Implementation notes

- **Protocol.** A `tasks` scope (grantable per phone, shown as "Tasks and plans") and seventeen
  `tasks.*` methods. Reads are `read`; edits, splits and pause are `write`; redo, start and resume
  are `danger`, so they are written to the audit log.
- **Bridge.** `main/remote/manage/taskMethods.ts` builds the phone's views on the computer (rows
  with their status labels, task sections and criteria, records with their fields as label and
  value) and checks every input itself: task and record ids against their patterns, statuses and
  priorities against their lists, sections against the kind's own, dates as `YYYY-MM-DD`. Edits go
  through the same writers as the desktop's Tasks views (`planEdits.ts`), then `changed` tells the
  windows and schedules the plan commit (E123). `liveTasks.ts` wires it to the board, planner, redo
  and the relay runtime. A split carries a request id the phone can cancel.
- **Rust.** `ffi/src/tasks.rs` and `tasks_view.rs`: `Section::Tasks`, the overview, rows with a
  `meta` line written in the core, the task detail (moves, criteria with their index, handoff
  headings named as the desktop names them, journal), records by kind, and the split. The planned
  proposal stays in the runner until Add. Redo, start and resume ask first. A list answer in the
  demo can now vary by parameter (`tasks.items` by kind); `demo/answers/tasks.json` answers every
  method.
- **Android.** `ui/Tasks.kt`: Overview, Tasks, Records and Split, and the task on its own screen,
  under More. `IntroTest` scrolls to About, since the More list is now longer than the screen.
- **iOS.** `UI/Tasks.swift`, wired in `Device.swift` and `AppModel.swift`, with `TasksTests.swift`.
  Written on Windows to match Android, not compiled yet.

## Status

Desktop bridge, Rust core and Android are tested. iOS is written to match but not compiled until the
Mobile iOS CI job builds it. Not tried end to end against a real computer from a real phone.
