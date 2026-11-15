# E99 Cloudflare settings and rules on the phone

Milestone: standalone (Mobile). Depends on: E98.

## Goal

The rest of a domain's tabs on the phone, as the desktop has them: SSL/TLS, Caching (with cache
purge), and Security (the security level, AI bots, WAF custom rules and IP access rules).

## Design

- A domain on the phone has the desktop's tab strip: DNS, SSL/TLS, Caching and Security (Access,
  Servers and Turnstile follow in E100 and E101).
- The Rust core (`crates/ffi/src/cloudflare/settings.rs`) describes every setting as a switch or a
  choice, with the desktop's title, description and words for each value, and a note where the value
  needs one (the SSL/TLS mode's advice, what the caching level and AI bot choice do, how long
  development mode has left). Android and iOS draw that one shape, so they cannot drift apart and a
  new setting needs no native code. A choice with seven options or more (browser cache TTL) folds
  behind its value.
- `cloudflare_change_setting(key, value)` sends a zone setting or a bot setting by the key its view
  carries, and says back what happened in the desktop's words. Choosing I'm Under Attack from the
  security level remembers the level to go back to, as the quick switch does.
- New bridge methods under the `cloudflare` scope: `purgeCache` (danger), `customRules`,
  `createCustomRule`, `setCustomRuleEnabled`, `deleteCustomRule` (danger), `accessRules`,
  `createAccessRule`, `deleteAccessRule` (danger). Each checks its input with the desktop's own
  functions.
- The rule builder has the desktop's three kinds (block countries, challenge a path, allow IP
  addresses); a description left empty is written from the rule, as the desktop suggests it.

## Tasks

- [x] T1 Bridge methods for purge, custom rules and access rules, with tests.
- [x] T2 Rust: the settings as switches and choices, the tabs, rules, access rules and purge.
- [x] T3 Android tabs, settings, rules, the rule builder, the access rule form and purge, with snapshots.
- [x] T4 iOS, written to match.

## Acceptance criteria

- AC1 Every SSL/TLS, caching, security level and bot setting the desktop shows can be changed from
  the phone, and says back what changed.
- AC2 Custom rules switch on and off, are deleted after asking, and are added from the builder.
- AC3 IP access rules are added and deleted after asking.
- AC4 The cache is purged whole after asking, or file by file.

## Status

Desktop bridge, Rust core and Android are tested. iOS is written to match but not compiled yet, as
for E98.
