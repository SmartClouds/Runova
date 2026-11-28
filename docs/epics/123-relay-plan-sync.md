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

- [x] T1 The plan committer with the pathspec, debounce and skips.
- [x] T2 STATUS.md.
- [x] T3 Behind origin and Pull.
- [x] T4 Duplicate ids and renumbering.

## Acceptance criteria

- AC1 Changing a task's status in the app makes one commit with only the plan folder in it, while
  another staged file stays staged.
- AC2 A duplicate id after a pull is found and fixed with its references.

## Tests

- Main tests against real temporary git repos: pathspec commits, debounce, skips, STATUS.md,
  renumbering.

## Implementation notes

- **Committer.** `main/relay/planCommit.ts` keeps one timer per project. `schedulePlanCommit` is
  called whenever the plan folder changes: every relay IPC write (through `changed`), the driver's
  file changes (task statuses) and every recorded leg (its journal). Five quiet seconds later it
  checks the repo (a work tree, a HEAD, no MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD,
  rebase-merge or rebase-apply), refreshes STATUS.md, reads `git status --porcelain -z` for the
  folder and, when something changed, runs `git add -A -- <folder>` and
  `git commit -m <message> -- <folder>`. A pathspec commit takes only those paths, so other staged
  work stays staged. Git runs with arguments, never through a shell, so odd file names are data.
  The timer is unref'd. `options.commitPlan` (default on) turns it off per project, from Run
  settings.
- **Messages and STATUS.md.** `relay/sync.ts` in core: `planCommitMessage` names what was added,
  updated and removed by id (journals and handoffs alone read as "record progress"), capped at 100
  characters; `renderStatusFile` holds no time of its own, so it changes only when the plan does.
- **Remote.** `PlanSyncStrip` in the board reads the existing `git.status` (ahead and behind its
  upstream) and offers Pull, Push and a check that fetches. Pushing is never automatic.
- **Duplicate ids.** `duplicatesIn` lists ids two files share across tasks and record folders; the
  plan pack carries them and the Overview offers to renumber the second file (`relay:renumber`,
  its name checked against a strict pattern). References to the old id are left for a person to
  point at the right file.

## Status

Complete. Tests: core message and STATUS.md cases; committer cases against real temporary git
repos (pathspec only, other staged work untouched, no commit when nothing changed, one commit per
burst, skips when off, mid-merge or before the first commit, a file name with a quote and shell
characters); IPC renumber with hostile paths; the sync strip and the duplicate notice; a
`relay.e2e.ts` case where a task added in the app becomes one commit with only the plan folder
while another staged file stays staged.
