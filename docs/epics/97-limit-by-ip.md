# E97 Limit by IP address

Milestone: standalone (Deploy, security). Builds on E14 (Cloudflare, WAF custom rules) and E96
(the zone's Access tab).

## Goal

Only the addresses and ranges the user lists can open a name of a zone, one path on it, or every
name in the zone. Everyone else gets Cloudflare's block page before the request reaches the server.
Each limit is managed in the app: added, changed, paused and deleted from the Access tab.

## Tasks

- [x] T1 `addressInList` (`shared/cloudflare/ip.ts`): an address inside a listed address or range,
  never across IPv4 and IPv6.
- [x] T2 The `ip-lock` rule (`shared/cloudflare/rules.ts`): built as a block rule, read back with
  `parseIpLock`, which only accepts an expression the app would write itself.
- [x] T3 The words (`shared/cloudflare/ipLock.ts`): what a limit covers, the dialog's sentence, the
  Cloudflare description, and typed or pasted addresses split up with a reason for each bad one.
- [x] T4 `updateCustomRule` in the Cloudflare service, and its IPC channel and preload call: an IP
  limit changed in place, keeping its place and its on or off state.
- [x] T5 The Access tab's **Limit by IP address** card, the dialog and the address field.
- [x] T6 Help and this file.
- [x] T7 e2e: a path limited, changed, paused and deleted against the Cloudflare fake.

## Acceptance criteria

1. A limit goes on one name, one path on it (exactly, or with everything under it), or every name,
   for up to 100 addresses and ranges.
2. Anyone not listed is blocked by Cloudflare; a limit that covers `/.well-known/acme-challenge/`
   leaves it open so HTTP-01 renewals still work.
3. A limit can be changed, switched off and on, and deleted. Only rules that read back as an IP
   limit the app wrote are shown on the card or changed; other custom rules are never touched.
4. The dialog offers this computer's public address and warns when the list leaves it out.

## Implementation notes

- A limit is a WAF custom rule in the zone's `http_request_firewall_custom` entry point, action
  `block`, added after the rules already there. The expression is built from checked parts only:
  `(http.host eq "<name>" and starts_with(http.request.uri.path, "<path>") and not ip.src in {...})`,
  with the host and path parts left out for every name and every page, and
  `not starts_with(http.request.uri.path, "/.well-known/acme-challenge/")` added whenever the limit
  would cover that path.
- Cloudflare is the only record: the card reads the zone's custom rules (the same query as the
  Security tab) and keeps those `parseIpLock` accepts. `parseIpLock` builds the rule again from what
  it read and keeps it only when the expression comes out the same.
- `updateCustomRule` refuses any spec but `ip-lock`, and any existing rule that is not an IP limit,
  both in the IPC handler and in the service.
- The names offered are the zone's proxied A, AAAA and CNAME records (no wildcards), from the DNS
  records query. This computer's address comes from the same lookup as the status bar (`ipGeo`).
- An "Allow IP addresses" rule from the Security tab goes first and skips the rules after it, so the
  addresses it lists get past a limit too.

What is left or unverified:

- Nothing here has met the real Cloudflare API or edge, only the recorded fake. The expression uses
  the rules language as Cloudflare documents it.
- Cloudflare's Free plan holds five custom rules per zone. Past that, Cloudflare's own message shows.
