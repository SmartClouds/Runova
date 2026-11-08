# E75 Git

Milestone: standalone (Mobile). Depends on: E73.

## Goal

Work with a project's git from the phone: see changes and diffs, stage, commit, switch branches and
sync.

## Design

Methods wrap `workspaceGit` and `git:*` under the `git` scope. The host computes diff hunks and caps
their size. Discard, branch delete, and stash drop are high risk and ask first.

## Tasks

- [ ] T1 Bridge methods and the working tree subscription
- [ ] T2 Host-side hunks with a size cap
- [ ] T3 `store` and screens: changes, diff, commit, branches, stashes, conflicts

## Acceptance criteria

- AC1 A change made on the computer appears on the phone without refreshing.
- AC2 Stage, commit and push from the phone produce a real commit on the remote.
- AC3 A file over the cap says so instead of loading.
- AC4 A push failure shows git's reason.

## Not in this epic

Line-by-line staging and pull requests.
