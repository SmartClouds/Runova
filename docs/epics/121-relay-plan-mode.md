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

- [ ] T1 Core: types, parse and render for PLAN.md, milestones, decisions, workarounds, risks,
      questions and the journal; new task fields; new handoff sections.
- [ ] T2 Core: the guide, the plan-mode planner request, proposal milestones, risks and questions,
      the leg prompt's pointers, `reviewEachTask`.
- [ ] T3 Desktop: reading the new files on the board, the journal writer, redo, the planner's mode.
- [ ] T4 Split dialog and Blueprint: the mode choice.
- [ ] T5 Help and e2e.

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
