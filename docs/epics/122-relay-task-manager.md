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

- [ ] T1 IPC and writers for every edit.
- [ ] T2 Overview, Board and List.
- [ ] T3 Roadmap and the item views with edit.
- [ ] T4 Workaround revisit check and Fix with AI.
- [ ] T5 Blueprint writes the plan pack. (The prompt side came with E121: with Relay on it asks
      for PLAN.md, milestones, risks and questions. Left: open the Tasks tab from the banner.)
- [ ] T6 Help articles, website feature pages, e2e.

## Acceptance criteria

- AC1 Every field a task file has can be changed in the app, and the file keeps everything else.
- AC2 A workaround waiting for a version that is now out shows Ready to revisit.
- AC3 A Blueprint in plan mode writes PLAN.md, milestones and parts that open in the Tasks tab.

## Tests

- Renderer tests for each view and editor; main tests for the writers and the revisit check.
- e2e: editing a task, a workaround flagged ready, the Blueprint in plan mode; the existing projects
  and prompt builder e2e.
