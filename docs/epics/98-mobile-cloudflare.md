# E98 Cloudflare on the phone

Milestone: standalone (Mobile). Depends on: E71 (manage bridge), E14 (Cloudflare). Followed by E99
(zone settings and rules), E100 (Access: email code gate and IP limits) and E101 (Turnstile, DNS
tokens, origin lock and Tunnel), which together put every Cloudflare feature of the desktop on the
phone.

## Goal

Manage Cloudflare from the phone through the connected computer: its connected accounts and their
tokens, the domains, a domain's quick switches and DNS records, adding a domain, and pointing one
at a saved server. The phone never holds a Cloudflare token: every call goes to the computer's own
Cloudflare service with the tokens saved there.

## Design

- A new grantable scope, `cloudflare` ("Cloudflare: domains, DNS, security and access rules, with
  the tokens saved here"), so a person can give a phone Deploy without Cloudflare or the other way.
- `cloudflare.*` methods in `packages/protocol/src/manage.ts`. The desktop side
  (`main/remote/manage/cloudflareMethods.ts`) checks every parameter with the same functions the
  desktop's IPC uses (`cloudflareInputs`, exported from `main/ipc/cloudflare.ts`) and calls the live
  `CloudflareService`. Refusals come back in words, without the desktop's code tags.
- The account status a phone sees names missing permissions as Cloudflare's token page does, and
  never carries a token or its id.
- A token pasted on the phone is checked there first (the same rules as the desktop), then waits for
  the phone's own biometric check before it is sent, as Vault reveal does. It is held in zeroized
  memory until then. `cloudflare.saveToken` is `danger` and audited on the computer.
- Rust (`crates/ffi/src/cloudflare.rs`, view types in `cloudflare_view.rs`) owns all of it: names
  shortened against the domain ("@", "www") and filled in again, TTLs and time left in the
  desktop's words, the record shapes per type, the level to go back to after I'm Under Attack, and
  the plan for pointing a domain. Native code draws and sends intents.
- The same screens on Android (`ui/Cloudflare.kt`) and iOS (`UI/Cloudflare.swift`), reached from
  More: accounts with their domains, a domain with its switches and DNS records, a record editor for
  A, AAAA, CNAME, TXT, MX, CAA and SRV, the token form, add a domain, point to a server.

## Tasks

- [x] T1 Protocol: the `cloudflare` scope and the E98 methods; the desktop's approval screen names it.
- [x] T2 Desktop bridge methods over the live Cloudflare service, with the desktop's own checks.
- [x] T3 Rust core: accounts, zones, records, switches, add domain, point domain, the token behind
  biometrics.
- [x] T4 Android screens and Roborazzi snapshots; the kit's text field gets an accessible name.
- [x] T5 iOS screens and snapshot tests, written to match Android.

## Acceptance criteria

- AC1 Each account says how its token stands and lists its domains; a locked one says to unlock
  Servers on the computer.
- AC2 Development mode, I'm Under Attack (back to the level before) and Block AI bots switch from the
  phone.
- AC3 Records of every type the desktop edits can be added, changed, proxied and deleted, a delete
  after asking.
- AC4 A pasted token leaves the phone only after its biometric check, and is refused on the phone
  when it cannot be a token.
- AC5 Pointing a domain shows the changes before applying them.

## Status

Desktop bridge (Vitest), Rust core (`cargo test`, clippy) and Android (JUnit, Compose, Roborazzi)
are tested. The iOS screens and tests are written to match Android but have not been compiled: they
need the Mobile iOS CI job, which runs on a push. Nothing has run against a real phone, computer and
Cloudflare account together.
