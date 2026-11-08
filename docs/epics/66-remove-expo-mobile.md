# E66 Remove the Expo mobile app

Milestone: standalone (Mobile). Depends on: none.

## Goal

The Expo screen remote is gone from the repo and from delivery, with nothing left behind that
breaks CI, CD or the docs, so the new app starts from a clean `apps/mobile`.

## Design

The app talks only to the desktop over the LAN, so no server code goes with it. The LAN remote
control itself stays, because desktop to desktop still uses it.

Kept on purpose: the desktop Android SDK and emulator feature, `@runova/protocol`, pairing codes,
`apps/desktop/src/main/remote/tokens.ts`, the host QR code, the JPEG tile path, and the phrase
"running the mobile app on the Android emulator" that `helpBuild.spec.ts` asserts.

## Tasks

- [x] T1 Delete `apps/mobile` and `run-mobile-android.{bat,sh}`
- [x] T2 CI and CD: the `build-android` job, its `needs` entry and APK step in `cd.yml`; the `mobile`
  job in `test.yml`; the comments in `test.yml` and `ci.yml`
- [x] T3 Workspace: `mobile` and `test:mobile` scripts, the Expo exclusions in `pnpm-workspace.yaml`,
  `pnpm-lock.yaml`, `scripts/coverage-summary.mjs`
- [x] T4 Help and website together, since `helpFilter.test.ts` couples them: `remote.md` and the
  rules in `web/src/lib/help/filter.ts`
- [x] T5 README and the comments and version pin test in `packages/protocol`

## Acceptance criteria

- AC1 No tracked file refers to `apps/mobile`, `@runova/mobile`, or the removed scripts and jobs,
  apart from epic history.
- AC2 `pnpm install --frozen-lockfile`, type check, unit tests and the website help filter tests
  pass.
- AC3 The release workflow still parses and no job needs a removed job.
- AC4 Desktop to desktop remote control and the desktop Android feature are unchanged.

## Not in this epic

The new app. The website's rule against mentioning a mobile app stays.
