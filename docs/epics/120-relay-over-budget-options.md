# E120 Over-budget run options for Relay

Milestone: standalone (Build). Depends on: E26.

## Goal

A task that is bigger than its context budget no longer stops the work. When splitting into tasks
(Prompt Builder, Build Prompt and Blueprint) and in a project's run settings, two separate
checkboxes say what happens to a big task:

- **Keep handing off.** Sessions still hand off near the budget and a fresh one carries on, with no
  limit on how many sessions one task may take. The planner may leave a big task whole instead of
  splitting it to fit.
- **Run past the budget.** A session is never told to hand off because of its context. It keeps
  going and the CLI compacts its own context. The handoff is still written when the session stops.

## Design

- `RelayOptions` gains `keepRolling` and `runPastBudget`, both off by default, so nothing changes
  for a board that does not ask for it.
- `keepRolling` skips the `leg-cap` pause in `completeLeg`. A task's "Over budget" label becomes
  information, not a warning.
- `runPastBudget` never arms the context guard, so the hook never sends the "finish the step and
  hand off" message, and the "budget too small" warning is not raised. The MCP `context_status` tool
  tells Codex and Copilot there is no limit.
- The `no-progress` pause (two identical handoffs in a row) stays in every mode. It is the one stop
  that keeps a stuck task from running forever.
- The planner's sizing rules get a second form for `keepRolling`: the estimate is still asked for,
  but a task may be larger than the budget when splitting it would cut a piece of work in half.
- The budget picked in the split dialog was only told to the planner. It is now written into each
  new task's `budget`, and the two options are passed to the run.
- The Blueprint's relay setting (`BlueprintRelaySetting`) keeps the two flags with the budget.

## Tasks

- [x] T1 Runner and gate: the two options, with tests.
- [x] T2 Planner prompt and proposal: the sizing variant and the budget written into tasks.
- [x] T3 UI: the checkboxes in the split dialog, Build Prompt, the Blueprint review step and the run
      settings; the Blueprint setting and its IPC check.
- [x] T4 MCP `context_status`, the help article and an e2e case.

## Acceptance criteria

- AC1 With Keep handing off on, a task that needs more than six sessions finishes without the relay
  pausing.
- AC2 With Run past the budget on, a session that goes over its budget is never told to hand off.
- AC3 Two identical handoffs in a row still pause the relay in every mode.
- AC4 A task added from the split dialog carries the budget picked there.

## Tests

- Core: runner cases for each option and the no-progress stop, gate, prompts, proposal.
- Desktop: the dialog, Build Prompt, the Blueprint review step, run settings, the blueprint IPC
  check, the MCP tool.
- e2e: the fake Claude rolls a task past six sessions.

## Implementation notes

- **Runner.** `RelayOptions.keepRolling` skips the `leg-cap` check in `completeLeg`;
  `runPastBudget` returns from `onContext` before the guard is armed, so neither the hook message
  nor the "budget too small" warning is sent. The no-progress check runs first and is untouched.
  `service.ts` reports no guard point (`guardAt: null`) so the fuel ring draws none.
- **Settings.** `relay.json` keeps the two flags optional in its schema, so settings saved before
  them still read; `relaySettings` fills them from `DEFAULT_RELAY_OPTIONS`.
- **Planner.** `sizingRules(budget, keepRolling)` and `blueprintRelaySection(..., keepRolling)` drop
  "split anything larger" and say a task carries on in a new session. The planner takes
  `keepRolling` from the dialog, or from the project's settings when not given (revise and catch-up).
- **Leg prompt.** With `runPastBudget` the prompt says Runova sets no context limit, in place of the
  budget line, for relay legs and single runs alike. MCP `context_status` says there is no limit.
- **Budget.** `withBudget` (core `proposal.ts`) gives new and split tasks the dialog's budget unless
  the planner set one.
- **UI.** `OverBudgetOptions` (two checkboxes) sits under the budget in Split into tasks, which the
  Prompt Builder and Build Prompt both open, and in the Blueprint review step. The dialog starts
  from the project's saved choice and saves a changed one when tasks are added. The Blueprint keeps
  them in `BlueprintRelaySetting` and writes them to the project's relay settings when its prompt
  is run. Run settings has a switch for each.

## Status

Complete. Tests: runner, prompts, proposal and Blueprint prompt cases in core; relay store, planner,
MCP tool and Blueprint IPC cases in main; the split dialog, run settings and Blueprint review step
in the renderer; two new `relay.e2e.ts` cases (a task rolling past a two-session limit, and a
session past its budget that is never told to hand off).
