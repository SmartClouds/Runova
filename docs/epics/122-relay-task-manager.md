# E122 A task manager on the desktop

Milestone: standalone (Build). Depends on: E121.

## Goal

A project's tasks are managed in the app the way a project manager would want, not only planned
and run by AI. The Blueprint is the front door: it writes the plan, the milestones and the parts,
and the Tasks tab keeps them up to date.

## Design

- The project's Relay tab becomes **Tasks**, with these views:
  - **Overview**: progress by milestone, counts by status, what is blocked, what needs the person,
    open workarounds, risks and questions, and the latest journal entries.
  - **Board**: columns by status, with drag between them.
  - **List**: a table sorted and filtered by priority, milestone, labels, agent, due date and status.
  - **Roadmap**: milestones on a timeline with their target dates and progress.
  - **Graph**: the dependency track Relay already draws.
  - **Decisions**, **Workarounds**, **Risks** and **Questions**: lists with a detail pane and edit.
- **Editing by hand.** New task, edit any field, edit the body as markdown, tick acceptance items,
  split a task, archive it. New milestone, decision, workaround, risk or question; answer a question;
  turn a line of a handoff into a decision or a workaround. Every write goes through main to the
  atomic writers next to the task files. Agents still write only handoffs and the item files the
  guide asks for.
- **Workarounds that can go.** For an open workaround that names a dependency, the app compares
  `waitingFor` with the latest version the project's package check knows. When the new version is
  out, or `revisitBy` has passed, it shows "Ready to revisit", and Fix with AI makes a task from it.
- **Blueprint.** The review step offers the mode (fit the context budget, or plan only) and the run
  options. Generating writes PLAN.md and the milestones as well as the tasks. The banner opens the
  Tasks tab.

## Tasks

- [x] T1 IPC and writers for every edit.
- [x] T2 Overview, Board and List.
- [x] T3 Roadmap and the item views with edit.
- [x] T4 Workaround revisit check and Fix with AI.
- [x] T5 Blueprint writes the plan pack. (The prompt came with E121; the banner now opens the
      board on its Overview.)
- [x] T6 Help articles, website feature pages, e2e.

## Acceptance criteria

- AC1 Every field a task file has can be changed in the app, and the file keeps everything else.
- AC2 A workaround waiting for a version that is now out shows Ready to revisit.
- AC3 A Blueprint in plan mode writes PLAN.md, milestones and parts that open in the Tasks tab.

## Tests

- Renderer tests for each view and editor; main tests for the writers and the revisit check.
- e2e: editing a task, a workaround flagged ready, the Blueprint in plan mode; the existing projects
  and prompt builder e2e.

## Implementation notes

- **Main.** `relay/planEdits.ts` holds every edit: task fields (`updateTask`), the spec
  (`saveTaskBody`), one acceptance box (`toggleAcceptance`, counted as the card counts them), new
  and removed tasks (a task others depend on, or one in progress, is refused), PLAN.md
  (`savePlan`), records (`saveItem`, `removeItem`) and `taskForWorkaround`. Each changes only its
  own lines through `setFrontMatterValue` and `setBodySection`. Twelve `relay:*` channels carry
  them, each with a strict zod schema; ids are checked against their patterns before a path is
  built, and the IPC tests send hostile ids.
- **Revisits.** `workaroundRevisit` in core compares a workaround's `waitingFor` with the installed
  and latest versions the package check reports (ecosystem names like npm or cargo map to the
  check's own), and falls back to `revisitBy`. `relay/revisits.ts` runs the package scan only when
  some open workaround names a package and a version. `taskFromWorkaround` writes the task that
  takes one out, labelled `workaround`.
- **Watcher.** PLAN.md and the record folders count as board changes, so the views refresh when an
  agent writes them; the renderer refreshes the plan pack and journals with the board.
- **Renderer.** The board overlay has Overview, Board, List, Roadmap and Records views
  (`PlanViews.tsx`, pure helpers in `planView.ts`), New task, and dialogs to edit a task
  (`TaskEditDialog`), a record (`RelayItemDialog`) and the plan (`PlanEditDialog`). The task detail
  has Edit, tickable acceptance criteria and the journal. The board store can open on a view; the
  Blueprint banner opens the Overview.

## Status

Complete. Tests: core revisit and fix-task cases; main revisit cases and IPC cases for every new
channel; renderer helper, view, dialog and board cases; a `relay.e2e.ts` case that adds and edits a
task by hand, lists it, sees an overdue workaround flagged and turns it into a task.
