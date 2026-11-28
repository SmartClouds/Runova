# E121 Plan mode and the plan pack

Milestone: standalone (Build). Depends on: E26, E120.

## Goal

A person can break a big job into parts that have nothing to do with any context size, write a spec
for each part, and run each part on its own, now or later, with any agent. Everything a session
learns is written down in the repo so the next part, or a later redo with another agent, starts
from it: decisions, tests run, workarounds to remove when a new version comes out, open questions,
and a journal of every session.

## Design

Everything lives in the project's Relay folder (`<docs>/tasks/`) as markdown, so git keeps its
history. Every new field, file and section is optional when read, so existing boards keep working.

```
tasks/
  PLAN.md                       goal, mode, run options, definition of done, out of scope
  T###-slug.md                  a task, which is also its spec
  handoffs/T###.md              the handoff, with the new sections
  handoffs/archive/T###-attempt-N.md   earlier attempts of a part that was redone
  journal/T###.md               one entry per session, written by the app
  milestones/M###-slug.md       goal, target date, exit criteria, retrospective, changelog
  decisions/D###-slug.md        context, decision, consequences
  workarounds/W###-slug.md      what, why, proper fix, where, and when to revisit
  risks/R###-slug.md            likelihood, impact, mitigation
  questions/Q###-slug.md        a question for the person, and its answer
```

- **PLAN.md** holds the settings that belong to the project, so they travel with the repo:
  `mode` (`fit` or `plan`), `budget`, `keepRolling`, `runPastBudget`, `reviewEachTask` and the
  definition of done. Which CLI, model and effort to use stays on each computer.
- **Tasks** gain optional `priority` (p0 to p3), `size` (xs to xl), `milestone`, `labels`, `agent`
  (the CLI to run it with), `due` and `attempt`, and the app writes `started` and `finished`.
- **Handoffs** gain three sections: Tests run (the commands, their results and what is not covered),
  Workarounds (each one names its W### file) and Open questions. "None." is a fine answer. A handoff
  written before this epic still reads; the stop gate asks for the new sections only when the
  session started from the new template.
- **Workarounds** say what dependency they wait for (`dependency`, `ecosystem`, `waitingFor`) or a
  date to look again (`revisitBy`), and their status (`open`, `fixed`, `wont-fix`).
- **The guide** (`RELAY.md`) tells every session to write a D### file for a decision later parts
  depend on, a W### file for every workaround, a Q### file for a question, and the tests it ran.
- **Plan mode.** The planner gets a different request: no sizing rules, one part per reviewable,
  testable piece of work, a full spec for each (goal, context, approach, files and interfaces, scope,
  out of scope, acceptance criteria, test plan, risks), plus milestones, risks and questions. A part
  runs with Keep handing off and Run past the budget on, and `reviewEachTask` can pause after each
  finished part. A session's prompt points at PLAN.md, its spec, the handoffs of the parts it depends
  on and the open decisions and workarounds.
- **Journal.** When a session ends, the app adds an entry to `journal/T###.md`: when, which CLI,
  model and effort, the outcome, the tests result, the context used and the commit.
- **Redo with another agent.** A part, or every part, can be run again with another CLI. The handoff
  and journal move to `handoffs/archive/`, `attempt` goes up, the status goes back to todo and
  `agent` is set. The person chooses whether the new run reads what the earlier attempt learned
  (its decisions, workarounds and rejected approaches) or starts from the spec alone.

## Tasks

- [x] T1 Core: types, parse and render for PLAN.md, milestones, decisions, workarounds, risks,
      questions and the journal; new task fields; new handoff sections.
- [x] T2 Core: the guide, the plan-mode planner request, proposal milestones, risks and questions,
      the leg prompt's pointers, `reviewEachTask`.
- [x] T3 Desktop: reading the new files on the board, the journal writer, redo, the planner's mode.
- [x] T4 Split dialog and Blueprint: the mode choice.
- [x] T5 Help and e2e.

## Acceptance criteria

- AC1 Plan mode turns a request into parts with full specs, milestones, risks and questions, with no
  estimate checks.
- AC2 A finished session leaves a handoff with tests run and workarounds, and a journal entry.
- AC3 Redo moves the attempt to the archive and runs the part again with the chosen CLI.
- AC4 A board written before this epic reads and runs as before.

## Tests

- Core: round trips for every new file, bad front matter turned into issues, prompts, proposal,
  runner.
- Desktop: board reading, journal, redo, planner, dialog.
- e2e: a plan-mode split and run, and a redo.

## Implementation notes

- **Core.** `relay/plan.ts` reads and writes PLAN.md, the five kinds of record (one spec per kind in
  `RELAY_ITEM_SPECS`: prefix, folder, statuses, sections), the journal and the attempt archive, all
  through the same lenient front matter reader as tasks. `planRunOptions` turns a plan into run
  options; a plan only turns options on, never off, so a choice made on one computer is never undone
  by the repo. Tasks gained `priority`, `size`, `milestone`, `labels`, `agent`, `due`, `attempt`,
  `learnFrom`, `started` and `finished`, and plan-mode bodies (Context, Approach, Interfaces and
  files, Out of scope, Risks).
- **Handoffs.** `HANDOFF_SECTIONS` has Tests run, Workarounds and Open questions, marked
  `sinceTemplate`: they count as missing only when their heading is there, so a handoff written
  before them stays complete, and the task detail hides them on such a handoff.
- **Guide.** `relay/guide.ts` carries a version marker. `ensureGuide` replaces a guide Runova wrote
  (version 1 is recognised by its closing line) and leaves alone one a person wrote. It explains both
  modes and the "Records you keep" rules.
- **Planner.** `buildPlanRequest` and `PLAN_PROPOSAL_SHAPE` ask for the plan, milestones, risks,
  questions and specced parts with no sizing rules. `applyProposal` numbers new records after the
  ones on disk, renames milestones the planner numbered so tasks follow them, and returns the record
  files and PLAN.md. Main writes PLAN.md only when there is none, and otherwise only switches its
  mode.
- **Runs.** The service merges `planOptions` from PLAN.md, and a task file's `agent` becomes its
  CLI unless this computer has an override. `reviewEachTask` pauses after every finished task
  except the last. The leg prompt points at PLAN.md, at the decisions and workarounds folders when
  they hold records, and at the archived attempt named by `learnFrom`.
- **Journal.** The wiring wraps `addLegRecord`: every recorded leg appends to `journal/T###.md`,
  with the commit when HEAD is newer than the session's start.
- **Redo.** `relay:redo` archives handoff and journal into `handoffs/archive/T###-attempt-N.md`,
  raises `attempt`, clears the timestamps, unticks the criteria, sets `agent` and `learnFrom`, and
  can start the tasks. A task in progress is refused. The task detail has a Redo button.
- **UI.** `PlanModePicker` (Fit the context budget / Plan only) in Split into tasks and on the
  Blueprint review step; plan mode hides the budget and the over-budget options. The Blueprint
  prompt with Relay on now asks for PLAN.md, `milestones/`, `risks/` and `questions/` instead of
  MILESTONES.md and RISKS.md, and in plan mode for specced parts with no estimate or budget. Run
  settings has Review each task.

## Status

Complete. Tests: core plan, parse, format, prompts, proposal, runner and Blueprint prompt cases;
main plan files, redo, service, IPC (redo, plan-mode apply and decompose) cases; renderer split
dialog, Redo dialog, run settings and Blueprint review step cases; a `relay.e2e.ts` case that plans
in plan mode, runs a part, checks its journal, redoes it and sees the new session read the archive.
