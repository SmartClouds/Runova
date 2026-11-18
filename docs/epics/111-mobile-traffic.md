# E111 Traffic and attacks on the phone

Milestone: standalone (Mobile). Depends on: E109, E110, E73 (the phone's link to the computer).

## Goal

The traffic report and the attacks of each Deploy server's websites on the phone, with blocking and
the settings, as the desktop's Traffic section has them.

## Design

- Bridge methods under the `deploy` scope reuse the desktop's own service and input checks:
  `traffic`, `trafficDimension`, `trafficAttacks`, `trafficBlocked`, `trafficBlock` and
  `trafficUnblock` (danger), `trafficStatus`, `trafficSaveSettings`.
- Auto-block and deleting statistics are not on the phone. Both take a step-up on the computer
  (auto-block is an Owner's call), so the phone says how auto-block stands and where to change it.
- The Rust core keeps the range, the site and the numbers formatted for the screens.
- Android draws the charts on a Canvas; iOS uses Swift Charts.
- Attack alerts already reach the phone's inbox (E82); opening one goes to that site's attacks.

## Tasks

- [x] T1 Bridge methods, with tests.
- [x] T2 Rust view and tests.
- [x] T3 Android screens and snapshot tests.
- [x] T4 iOS, written to match.
- [x] T5 Docs.

## Acceptance criteria

- AC1 A server's traffic shows on the phone for any range and site, with the same numbers as the
  computer.
- AC2 An attack opens on the phone from its notification, and its address can be blocked there.

## Implementation notes

- **Bridge.** `main/remote/manage/trafficMethods.ts`, registered with the other groups in
  `methods.ts` and wired to the live service in `liveDeploy.ts` (`liveTraffic`). The phone names a
  preset range (`today`, `7d`, `30d`, `90d`, `12m`) and an optional bucket; the computer reads the
  server's time zone and hourly retention from `trafficStatus`, works out the window with
  `shared/deploy/trafficRanges.ts` and fits the bucket with the desktop's own rules, so both apps
  count the same days. It sends back the bucket labels (axis and readout) in that zone, every
  breakdown capped at 8 rows with country names, and leaves out the hour-of-week heatmap. "See all"
  pages 50 at a time. Inputs go through the IPC's own checks (`deployTrafficInputs` in
  `main/ipc/deployTraffic.ts`). Blocking sends only an address and the site; the service checks it
  with `checkNetwork` and the core writes the nginx side. Saving settings sends only what changed
  and keeps the rest (excluded sites, time zone, thresholds, allowlist). The desktop's two report rules
  live in `shared/deploy/trafficCompare.ts` and apply to both: Unknown, Other and blank values sort
  last in every breakdown, and a period before that started before statistics were counted gives
  no changes ("No earlier data" on the tiles) and no previous points before counting began. An older core reads
  "This server runs an older core without traffic statistics..." on the phone.
- **Notifications.** The desktop forwards an attack alert with `itemId` `<server>:<site>` (falling
  back to the server when the pair is over the 64 characters a push carries). `deploys`
  notifications now open Deploy on the phone; an attack opens that site's Attacks tab, from the
  inbox or a tapped push, and a push tapped before the computer is connected waits for it. A
  target that is not a saved server (a files site's review) opens only the list.
- **Rust.** `ffi/src/traffic.rs` and `traffic_view.rs`: the range, site, bucket and tab, KPI tiles
  written as `trafficFormat.ts` writes them (12.9K, 42%, 1m 35s, 1.5 GB, "+16%" with good or bad
  news, "about" for visitors), the chart's points with both periods and a readout for each, shares,
  flags from ISO codes, attacks with Block behind a question (Admins and Owners only), the blocked
  list with Unblock behind a question, the settings sheet (statistics, countries, hourly and daily
  retention, detection) and "See all". Reports refresh once a minute, the lists about every 30
  seconds. Tests in `ffi/tests/traffic.rs`.
- **Android.** `ui/Traffic.kt`: a Traffic entry on the server screen, tabs for Overview, Attacks and
  Blocked, KPI tiles, the chart on a Canvas with the period before dashed and a touch readout,
  devices as a ring, breakdown bars, countries with flags, the settings sheet and "See all".
  Snapshots `traffic*.png` in both themes; tests in `TrafficTest.kt`.
- **iOS.** `UI/Traffic.swift` with Swift Charts for the chart (the ring is drawn by hand, since
  sector marks need iOS 17), wired in `AppModel.swift`, `Device.swift` and the push handler, with
  `TrafficTests.swift`. Written on Windows and not compiled yet: it needs the Mobile iOS CI job.

## Status

Desktop bridge, Rust core and Android are tested. iOS is written to match but not compiled. The
bridge reuses the desktop traffic service, whose hub methods are tested against the fake core; the
server core side (E109, E110) is still being built, so nothing here has met a real server yet.
