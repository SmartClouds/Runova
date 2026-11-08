# Runova mobile: architecture

The mobile app manages a person's computers from a phone: see them, connect, and work with
projects, CLIs, git, usage, Vault, Remote, Deploy, Monitoring, Pipelines, notifications, account,
sessions and teams. It replaces the Expo screen remote. Epics E66 to E84 deliver it.

## Decisions

| Topic | Decision |
|---|---|
| Shared code | A Rust core, reached through UniFFI |
| UI | Kotlin with Jetpack Compose, and SwiftUI. A custom component kit on both, no Material or Cupertino components |
| iOS builds | On the Mac mini runner, with a paid Apple account |
| Phone access | Approve once at the computer. The computer pins the phone's key and grants scopes: `terminal`, `git`, `vault`, `deploy`, `ops`, `control`, `files`. Revocable from either side |
| Push | FCM and APNs with one short line such as "Deploy failed on prod". Never terminal output or secrets |
| Website | Stays silent about the mobile app (`docs/epics/40-website.md`). Phones appear as "Runova app" with a generic device name |
| Realtime | SignalR for presence, signaling and notifications. Data goes peer to peer over a WebRTC data channel, then falls back after 8 s to the end-to-end encrypted relay, as remote desktop does |
| Reconnect | No server resume token. PTYs survive on the desktop and a trusted phone skips the prompt, so coming back from the background opens a fresh link and resubscribes |
| Data routing | Device data goes through the connected computer. Account, sessions, teams, directory, cloud monitors and notifications go straight to the server |

## Layout

```
apps/mobile/
  core/            Cargo workspace (no package.json, so pnpm -r ignores it)
    protocol       message types, link framing, conformance vectors
    crypto         Ed25519/X25519/HKDF handshake, relay AES-GCM, zeroized secrets
    signalr        hand-written JSON hub protocol on tokio-tungstenite
    api            REST client, PKCE sign-in, single-flight refresh rotation
    link           peer to peer then relay state machine behind a PeerTransport trait
    rpc            management client, subscriptions, flow control
    term           VT parser and capped cell grid
    store          one state machine per screen, emits view state
    ffi            UniFFI surface, the only crate native code sees
  android/         Gradle, Kotlin, Compose
  ios/             XcodeGen project.yml (no hand-edited pbxproj), SwiftUI
  design/          generated tokens, icon list, shared view-state fixtures
```

Rust owns the logic and native code draws. A screen renders a view state from `store` and sends
intents back, so behavior is the same on both OS and almost all of it is tested with `cargo test`.

## Management RPC

- Contract in `packages/protocol/src/manage.ts`, vectors in `test-vectors/manage-v1.json`, read by
  both Vitest and `cargo test`, the same way `anywhere-v1.json` is.
- Runs over the existing `runova-link` under a new `manage` intent. The host advertises `manage/1`;
  an older desktop shows "Update Runova on this computer".
- Text frames carry JSON calls, binary frames carry terminal bytes.
- An explicit allowlist, not a proxy over the IPC handlers. Handlers call existing services
  directly.
- Every method declares a scope and a risk level and is audited on the computer, reusing the AI
  Access machinery in `apps/desktop/src/main/aiAccess/`, because the `senderFrame` guards do not
  apply on this path.

## Same UI on both OS

- Kotlin and Swift tokens are generated from `apps/desktop/src/renderer/src/index.css`, with a
  drift test.
- Inter and JetBrains Mono are bundled on both, and the FontAwesome solid icons come from one
  generated set.
- Navigation chrome comes from the kit, so it is the same on both.
- The same fixture states render to screenshots on each OS, and CI compares Android with iOS within
  a tolerance.
- Things the OS owns still differ: status bar, keyboard, system back gesture and how system
  notifications look.

## Memory

Budgets, measured as Android PSS and iOS phys_footprint: connected and idle 120 MB, terminal open
150 MB, remote screen 300 MB. E72 calibrates them from the empty shell; after that they only go
down.

- A small tokio runtime (2 workers), bounded channels everywhere, one live computer link at a time.
- Scrollback capped at 2000 lines for the focused terminal only. Others are dropped and fetched
  again from the host snapshot.
- Grid deltas cross FFI as compact bytes, not per-cell objects. Status streams run only while
  visible.
- The host computes git diffs and caps their size. The phone never loads two full file versions.
- Video goes to hardware decoder surfaces, created on open and released on close.
- The link closes 30 s after going to the background and push takes over. `onTrimMemory` and memory
  warnings call `core.trim()`.

## Phone security

The identity seed is wrapped by Android Keystore or iOS Keychain. TLS only, no cleartext. Vault
screens block screenshots and hide in the app switcher. Vault reveal needs biometrics on the phone
and is audited on the computer. The host's audit log is visible on the desktop.

## Tests

Work is test-first: every epic starts with failing tests.

| Layer | Tools | Proves |
|---|---|---|
| Rust | `cargo test`, `clippy`, `llvm-cov` floors | All logic and state machines |
| Wire | Shared vectors in Vitest, Cargo and .NET | All implementations agree |
| Server | xunit integration tests, mapper unit tests | Hubs, auth, push, trust rules |
| Desktop | Vitest, `ipcContract`, Playwright | Bridge, scopes, audit, approval dialog |
| Android | JUnit, Compose tests, Roborazzi | Screens against fixtures |
| iOS | XCTest, swift-snapshot-testing | The same fixtures |
| Parity | Android and iOS screenshots compared | Same UI on both |
| End to end | One Maestro flow set on both OS against a fake host, plus real desktop interop | Same behavior, real connectivity |
| Memory | Soak tests with budgets on each OS | Budgets hold over time |

## Known limits

- The old app's offline LAN mode is gone. QR pairing is dropped, so the phone needs internet for
  signaling even on the same network as the computer. ICE still picks the direct LAN path for data.
- Device features need the computer online with Runova running. Agent-only computers offer the
  remote screen only.
- No TURN, by design. Many mobile networks land on the relay, which is fine for RPC and terminals;
  the remote screen there usually means JPEG tiles.
