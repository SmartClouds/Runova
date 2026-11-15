# E100 Cloudflare Access on the phone

Milestone: standalone (Mobile). Depends on: E98, E96 (email code gate), E97 (limit by IP address).

## Goal

The domain's Access tab on the phone: the email code gate on each name, and IP limits, with the
same choices and words as the desktop.

## Design

- Bridge methods under the `cloudflare` scope: `emailGatePlan`, `emailGatePrepare`,
  `emailGateSave`, `emailGateRemove` (danger), `emailGateLetThrough`, `emailGateProxy`, `ipLimits`,
  `saveIpLimit` and `publicAddress`. The gate's input goes through the desktop's own checks
  (`emailGateInputs`). IP limits are read back from their rules on the desktop with `parseIpLock`,
  and `saveIpLimit` writes the rule's description there, so the phone never reads or writes a rules
  expression. `publicAddress` is the computer's address from the status bar's cached lookup.
- "This computer" on the phone is the computer it is connected to: Let this computer through gives
  that computer its pass, and the IP limit form offers its public address and warns when the list
  leaves it out.
- Rust (`crates/ffi/src/cloudflare/access.rs`) reads people and addresses the way the desktop does:
  `Name <address>` from a mail app, `@company.com` or `company.com` for a whole domain, addresses
  and ranges written as Cloudflare writes them (a range must start at its own first address), each
  refusal with its reason. The gate form says back who can open the name and for how long; the IP
  limit form says who gets in and what everyone else sees. A new gate starts from the last list
  saved in this run of the app.
- The domain's tab strip scrolls sideways and keeps the open tab in view, now that there are five.

## Tasks

- [x] T1 Bridge methods for the gate, IP limits and the public address, with tests.
- [x] T2 Rust: the Access tab, the gate form, people and address parsing, the IP limit form.
- [x] T3 Android screens and snapshots.
- [x] T4 iOS, written to match.

## Acceptance criteria

- AC1 Each name shows what it is, who can open it, and a switch; names without the proxy offer to
  turn it on, and gates made elsewhere are shown and left alone.
- AC2 Email codes are turned on once, with a team name on an account without Zero Trust.
- AC3 A gate goes on with people typed or pasted and a session, is changed, and comes off after
  asking.
- AC4 IP limits are listed, added, changed, switched off and deleted after asking, with a warning
  when the computer would be shut out.

## Status

Desktop bridge, Rust core and Android are tested. iOS is written to match but not compiled yet.
