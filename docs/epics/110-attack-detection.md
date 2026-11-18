# E110 Attack detection and blocking

Milestone: standalone (Deploy). Depends on: E109 (the access log tailer), E30 (alerts and Telegram),
E82 (notifications on the phone).

## Goal

The server core watches its websites' traffic for attacks (scanners, login brute force, floods,
injection probes) and tells the people who run it, in Telegram and in the app, while it happens.
An address can be blocked with one click, and the core can block offending addresses by itself
when an Owner turns that on.

## Design

- **Detectors.** Pure classes fed the parsed lines by the E109 tailer, with sliding windows per
  address in bounded maps: scans (probe paths or many 404s), brute force (POSTs to login paths),
  floods (one address over a request rate, or a site far above its normal rate) and injection
  probes (SQL injection, XSS, path traversal, command injection, Log4Shell). Private and loopback
  addresses and the allowlist are never flagged.
- **Alerts.** Four new alert kinds, one open alert per site and kind, naming the top addresses with
  their country and counts. Ten quiet minutes resolve it. Telegram, the app's notifications and the
  phone get them through the paths E30 and E82 built.
- **Blocking.** A `geo` map at nginx's http level reads `blocked.conf`, outside the releases, and
  every site's server blocks answer a blocked address with 444. Blocking rewrites only that file,
  checks it with `nginx -t` and reloads, or puts the old file back. It never applies pending site
  changes, and it works behind Cloudflare, where a firewall rule would see only Cloudflare.
- **Auto-block.** Off by default. An Owner with a step-up turns it on per kind, with how long a
  block lasts and a cap on how many addresses are blocked. The allowlist and the address the app
  connects from are never blocked.

## Tasks

- [x] T1 Detectors.
- [x] T2 Alert kinds, attack events, Telegram titles; migration.
- [x] T3 Blocklist rendering and apply with rollback; system test.
- [x] T4 Auto-block policy and expiry.
- [x] T5 Hub methods, contracts, mappers, audit, roles.
- [x] T6 DevHost attack seeding.
- [x] T7 Desktop: alert titles, Telegram switches, the Security card, blocking, settings.
- [x] T8 End to end against the DevHost and a fake Bot API.
- [x] T9 Help article and docs.

## Desktop implementation notes

- **Alerts.** `main/deploy/watcher.ts` names the four kinds by their site ("Scan on blog
  (Production)", "Password guessing on shop (Production)", "Flood of requests on...", "Injection
  probes on..."). Their inbox entries and OS toasts open
  `/deploy?server=<id>&view=traffic&traffic=<site>&panel=security`: the Traffic section on that site,
  scrolled to the Security card. `shared/deploy/problems.ts` lists open attacks as `attack`
  problems, and the Telegram form gets the four switches from `TELEGRAM_ALERT_KINDS`.
- **Security card** (`components/deploy/traffic/SecurityCard.tsx`): attacks over the last 7 days
  stacked by kind, the recent addresses with country, kind, site, count, when and sample paths, a
  Block button for Admins that first says what happens ("nginx will refuse <address> on every site
  on this server") through the confirm dialog, and the blocked list with expiry and Unblock. It shows
  with statistics off too, since detection works on its own.
- **Settings.** The Traffic settings dialog has Detection (on or off, thresholds per kind, the
  allowlist, attack retention) for Admins and Auto-block (kinds, minutes with 0 for good, the cap)
  for Owners, saved after a step-up through the usual password dialog. Addresses and ranges are
  checked on this computer first (`checkNetwork`).
- **End to end** (`apps/desktop/e2e/deployTrafficAttacks.e2e.ts`): Telegram alerts set up with the
  fake Bot API, statistics on, a scan seeded on a site: the message reaches the fake Telegram, the
  inbox entry opens the site's Security view, and the address is blocked and let back in.
- **Help.** `src/shared/help/articles/deploy-attacks.md`, and the four kinds added to the Telegram
  article's table.

## Acceptance criteria

- AC1 A scan, a brute force, a flood and an injection probe each open one alert of their kind,
  which reaches Telegram and the app's notifications; ten quiet minutes resolve it.
- AC2 Block makes nginx refuse the address on every site within seconds, without applying pending
  site changes; Unblock lets it back.
- AC3 With auto-block on, an offending address is blocked for the set time and let back after; the
  allowlist and the app's own address never are.
- AC4 Only an Owner with a step-up can turn auto-block on.

## Core implementation notes

- **Detectors** (`Traffic/AttackDetector.cs`). A kind is an attack once its window reaches the
  threshold (20 probes or 50 not-founds in 5 minutes, 20 login POSTs in 5 minutes, 600 requests in a
  minute, 5 injection probes in 10 minutes by default). Windows count in tenths, so they are exact to
  a tenth of their length. One state per site and address, at most 50,000, the one quiet longest
  forgotten first. A site-wide flood needs an hour of history and a minute at ten times the hour's
  average and at least the per-address rate; its hits name every address but none is auto-blocked.
  Injection patterns are looked for in the path and query decoded twice (and `${` in the user agent),
  only when the request has anything but plain letters, digits and slashes. Local, loopback,
  link-local and carrier-grade NAT addresses, the allowlist and Cloudflare's addresses are never
  counted.
- **Alerts** (`AttackMonitor`). One open alert per site and kind, resource `site:<id>`. The message
  names the three busiest addresses with country and count ("3 addresses probed shop.example.com
  for files and admin pages: 198.51.100.7 (DE) 412 times, ... and 1 more."). Warning, Critical at five
  addresses or ten times the threshold. It is raised again at most once a minute while the attack goes
  on (at once when it gets worse), resolved after ten quiet minutes by a check on every tick, and at
  once when detection is turned off. Alerts open before a restart resolve once the site has been quiet
  ten minutes. Telegram titles: "A website is being scanned", "Someone is trying passwords on a
  website", "A website is flooded with requests", "A website is getting injection attacks".
  The Telegram file now keeps every kind there was when it was saved (`knownKinds`); a kind added
  to the core later counts as on, and a file from before this counts as knowing the eleven kinds
  before E110, so existing setups get the four attack alerts. A kind turned off and saved stays off.
- **Attack events.** One row per site, kind and address for as long as its attack lasts (a new one
  after the alert resolved), with up to five distinct sample paths, written once a minute. The series
  of `ListAttacks` counts events by the hour (the day, over three days) they began.
- **Blocking.** `geo $runova_blocked { default 0; include /etc/nginx/runova/blocked.conf; }` at the
  http level and `if ($runova_blocked) { return 444; }` in every server block of every site (port 80,
  443 and the tunnel's listener), but not the core's own site: blocking the address the app connects
  from must never shut out the person who runs the server. Setup, every apply and the recovery put an
  empty blocked.conf in place when it is missing (nginx -t refuses a missing include), and never
  replace one. `BlockList` writes only blocked.conf, under the applier's lock, runs nginx -t and
  reloads, and puts the old file back when nginx refuses either; before nginx is set up it only writes
  the file. `AddressBlocks` asks nginx first and saves the change only once nginx took it. On start the
  core writes the file from the database. Blocks that are refused: loopback, networks wider than /8
  (IPv6 /16), and any network holding the caller's own address. Private ranges can be blocked by hand
  (an address on the server's own network can attack it too), never automatically.
- **The app's addresses** (`AppAddresses`): the peer over direct TLS, the X-Forwarded-For nginx sets
  on the core's own domain, otherwise the SSH connection's client as the firewall finds it.
- **Auto-block.** Each newly flagged address of a chosen kind, unless an app is connected from it, it
  is already inside a block, or the cap (all blocks in force, manual ones included) is reached.
  Expired blocks are deleted and nginx told every minute, whether or not the logs are read.
- **System tests** (`tests/Runova.ServerCore.SystemTests/Nginx/NginxTrafficSystemTests.cs`, Debian 13
  and Rocky 9): a blocked address gets an empty reply (curl exit 52) without a new release, and gets
  answers again once unblocked; nginx refuses a broken blocked.conf.
- **DevHost**: `POST /dev/sites/attack` `{ "siteId": "blog", "kind": "scan", "address": "198.51.100.23" }`
  (`kind` is scan, bruteForce, flood or injection; `address` is optional and defaults to
  198.51.100.23) appends a burst a little past the current threshold, in the last half minute, and
  has the tailer read it at once, so the alert opens straight away. It answers `{ "lines": 25 }`, 404
  for no such site, 400 for an unknown kind or a bad address. Detection must be on. The DevHost's app
  connects from 203.0.113.50 (its pretend SSH client), which cannot be blocked.
