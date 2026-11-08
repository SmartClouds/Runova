# E71 Desktop management bridge

Milestone: standalone (Mobile, Remote). Depends on: E68, E70.

## Goal

A trusted phone can call an allowlisted set of desktop features over the link, each one scoped,
risk-rated and audited, after a single approval at the computer.

## Design

- `apps/desktop/src/main/remote/manage/`: router, scopes, audit, and event subscribers that are not
  windows. See `docs/mobile/architecture.md` for the contract.
- **Approve once**: a dialog with the safety code and scope switches, extending `decideIncoming` in
  `anywhere/service.ts`. A Trusted phones list on the Remote page revokes a phone.
- **Workspace tabs** live only in renderer localStorage, so the renderer publishes them to main,
  debounced.
- **Terminal attach comes first**: `sessionManager.ts` has code where a later attach supersedes an
  earlier one, and it is not confirmed that two clients can follow one session. A characterization
  test settles this before anything is built on it.

## Tasks

- [ ] T1 Characterization test of terminal attach with a second listener
- [ ] T2 `manage.ts` contract and `manage-v1.json` vectors, Vitest and Cargo both reading them
- [ ] T3 Router with scopes, risk levels and audit, reusing AI Access
- [ ] T4 Approve once, pinned phone keys, revocation
- [ ] T5 Non-window event subscribers with flow control
- [ ] T6 Workspace snapshot from the renderer
- [ ] T7 Projects as the first real method set

## Acceptance criteria

- AC1 An unknown phone gets nothing until approved at the computer; a revoked one is refused.
- AC2 A method outside the phone's scopes is refused and audited.
- AC3 A desktop terminal keeps working unchanged while a phone follows it.
- AC4 An unknown method name is refused: nothing outside the allowlist can be reached.

## Not in this epic

Feature methods other than projects, which arrive with their epics.
