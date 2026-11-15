# E101 Turnstile and DNS tokens on the phone

Milestone: standalone (Mobile). Depends on: E98.

## Goal

The domain's Turnstile and Servers tabs on the phone: widgets made, changed, deleted and rotated,
a widget's secret shown only after the phone's own check, and the DNS tokens the domain's servers
hold for wildcard certificates.

## Design

- Bridge methods under the `cloudflare` scope: `turnstileWidgets`, `createTurnstileWidget`,
  `updateTurnstileWidget`, `deleteTurnstileWidget` (danger), `turnstileSecret` (danger, audited),
  `rotateTurnstileSecret` (danger), `dnsTokens`, `provisionDnsToken` (audited, since a pasted token
  passes through the phone) and `removeDnsToken` (danger). Making or rotating a widget never sends
  its secret to the phone; the phone asks for it on its own.
- The phone's biometric check now guards three things the same way: a pasted Cloudflare API token
  (E98), showing a widget's secret, and a DNS token pasted for a server. Whatever waits for the check
  is held in zeroized memory, and a shown secret is wiped when it is hidden, when its tab or domain
  closes, and from every copy of the view the app has published.
- While a secret is on screen, Android keeps it out of screenshots and iOS hides it from the app
  switcher, as the Vault does.
- A widget card copies its site key, its secret once shown, and the HTML snippet that puts it on a
  page. The widget form has the desktop's mode, clearance and region choices and the two
  Enterprise switches.
- The Servers tab lists the saved servers with whether each holds a DNS token for the domain; one
  is made on the computer with the account token, or pasted, and removing one Runova made deletes
  it at Cloudflare too, after asking.

## Tasks

- [x] T1 Bridge methods, with tests.
- [x] T2 Rust: widgets, the secret behind the check, rotation, DNS tokens.
- [x] T3 Android tabs, the widget form and snapshots.
- [x] T4 iOS, written to match.

## Acceptance criteria

- AC1 Widgets are listed, made, changed and deleted after asking.
- AC2 A secret reaches the phone only after the biometric check, and is wiped when it leaves the
  screen.
- AC3 Rotating says whether the old secret keeps working, after asking.
- AC4 A server gets a DNS token made on the computer or pasted (after the check), and loses it
  after asking.

## Status

Desktop bridge, Rust core and Android are tested. iOS is written to match but not compiled yet. The
origin lock and Cloudflare Tunnel for each server follow in E102.
