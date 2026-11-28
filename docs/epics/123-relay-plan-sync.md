# E123 Plan sync through git

Milestone: standalone (Build). Depends on: E122.

## Goal

Every change to a project's plan reaches git on its own, so the history of the plan is the history
of the repo, and another computer or the phone sees it after a pull.

## Design

- **Auto-commit, push by hand.** After the plan folder changes (an edit in the app or on the phone,
  a finished session), the app waits five seconds for more changes, then commits only that folder
  with a pathspec, so nothing else the person has staged goes in. Messages read like
  `docs(tasks): T012 done` or `docs(tasks): add W003`. It does nothing during a merge or rebase, or
  in a repo with no commits. One setting per project turns it off. Pushing stays the person's call.
- **STATUS.md.** A progress summary of the plan, written from the board, so the state reads on
  GitHub and in the log. It is rewritten only when its content changes.
- **Behind origin.** The Tasks tab says when the branch is behind its upstream and offers Pull.
- **Duplicate ids.** Two computers can each add T030. After a pull the app finds duplicate T###,
  M###, D###, W###, R### or Q### ids and offers to renumber one, fixing `depends` and references.

## Tasks

- [ ] T1 The plan committer with the pathspec, debounce and skips.
- [ ] T2 STATUS.md.
- [ ] T3 Behind origin and Pull.
- [ ] T4 Duplicate ids and renumbering.

## Acceptance criteria

- AC1 Changing a task's status in the app makes one commit with only the plan folder in it, while
  another staged file stays staged.
- AC2 A duplicate id after a pull is found and fixed with its references.

## Tests

- Main tests against real temporary git repos: pathspec commits, debounce, skips, STATUS.md,
  renumbering.
