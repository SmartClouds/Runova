# E80 Pipelines

Milestone: standalone (Mobile). Depends on: E73.

## Goal

Follow and control CI from the phone.

## Design

Goes through the computer's `gh` CLI using `pipelines:*` under the `ops` scope. Job logs are
fetched in capped pages. Cancel and dispatch ask first.

## Tasks

- [x] T1 Bridge methods
- [x] T2 `store` and screens: status, runs, jobs, logs
- [x] T3 Dispatch and cancel

## Acceptance criteria

- AC1 Runs match the desktop's page.
- AC2 Dispatching and cancelling from the phone take effect on GitHub.
- AC3 A computer without `gh` signed in says so.

## Not in this epic

Auto-fix controls.

## Status

The bridge, the core and the Android screens are tested. A job log keeps its last 2000 lines rather
than paging. Dispatch uses the default branch. Owed: AC2
against GitHub, and the iOS screens have never been compiled.
