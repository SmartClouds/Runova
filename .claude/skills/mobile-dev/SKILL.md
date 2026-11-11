---
name: mobile-dev
description: Build, test and run Runova's mobile app (apps/mobile): the Rust core, the Android app and the iOS app. Use when working on anything under apps/mobile, or when asked to run its tests.
---

# Runova mobile development

Architecture and rules: `docs/mobile/architecture.md`. Delivery: epics E69 onward in `docs/epics`.

Rust owns the logic and native code only draws. A change in behavior belongs in `apps/mobile/core`
with a Rust test, and work is test-first.

## Rust core (`apps/mobile/core`)

| Task | Command |
|---|---|
| Tests | `cargo test --jobs 2` |
| Lint | `cargo clippy --jobs 2 --workspace --all-targets -- -D warnings` |
| Format | `cargo fmt --all` |
| Coverage (CI's floor) | `cargo llvm-cov --workspace --fail-under-lines 85` |

Keep `--jobs 2` on this machine: it runs out of memory otherwise.

`packages/protocol/test-vectors/*.json` are shared with Vitest and xUnit. Change them only with the
TypeScript implementation.

## Android (`apps/mobile/android`)

Needs JDK 17 or later (`JAVA_HOME` is Android Studio's JBR here; the `java` on PATH is 11 and is not
used), `local.properties` with `sdk.dir`, and `ANDROID_NDK_HOME` for the phone build.

| Task | Command |
|---|---|
| JVM tests against the real core | `.\gradlew.bat :app:testDebugUnitTest --console=plain --no-daemon` |
| Debug build | `.\gradlew.bat :app:assembleDebug --console=plain --no-daemon` |
| Faster debug build, as CI does | add `-PcoreAbis=x86_64 -PcoreProfile=ci` (one ABI, no LTO pass) |

## iOS (`apps/mobile/ios`)

Only builds on a Mac. From Windows, push and read the `Mobile iOS` CI job, using `gh --jq`.

1. `sh apps/mobile/ios/scripts/build-core.sh --simulator` for the tests (the Apple silicon
   simulator only, in the `ci` profile, as CI does). Without the flag it builds the device and both
   simulators in the release profile, for shipping, which takes far longer.
2. `cd apps/mobile/ios && xcodegen generate`, since the Xcode project is generated and never edited
3. `xcodebuild test -project Runova.xcodeproj -scheme Runova -destination "id=<simulator>" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=`.
   Keep the ad hoc signature: with `CODE_SIGNING_ALLOWED=NO` the app has no entitlements and the
   keychain refuses it.
