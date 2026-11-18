# E109 Website traffic statistics

Milestone: standalone (Deploy). Depends on: E10 (nginx websites), E14 and E95 (Cloudflare origin
lock and tunnel, for the visitor's real address and country), E30 (alerts and Telegram).

## Goal

Each Deploy server shows how its websites are used, read from the access logs nginx already writes
for every site: visitors, visits and page views per hour, day, week or month, unique visitors,
bounce rate, visit length, pages, entry pages, referrers, browsers, operating systems, devices,
countries and cities, status codes, response times, bandwidth and bots. It costs the server little,
and it can be turned off.

## Design

- **The core reads the logs.** The renderer gives every site's access log the `runova_main` format:
  nginx's `combined` fields, then the host, the request time, the content type, the scheme, the
  address that connected and Cloudflare's location headers. Old `combined` lines still parse.
- **One tailer** for all sites, on only while statistics or attack detection are on. Every five
  seconds it reads what each log gained since its saved offset, in 256 KB chunks, under a budget of
  8 MB a tick. Offsets and a fingerprint of each file's first bytes are kept in the database, so a
  restart continues where it stopped and a rotated file is finished from `*.log.1` first. Turning it
  on starts at the end of the logs, unless the person asks to read what is already there (up to
  200 MB).
- **Cheap parsing.** A span-based parser with no regular expressions, a small table-driven user
  agent classifier with an LRU cache, and an LRU of addresses to countries.
- **Countries.** Cloudflare's `CF-IPCountry` (and, when the zone's "Add visitor location headers"
  Managed Transform is on, `cf-ipcity` and `cf-region`), trusted only when the request came from
  Cloudflare's networks or the tunnel's listener. Otherwise DB-IP Lite's country database
  (CC BY 4.0), downloaded by the core once a month. The report says how many came from each.
- **Counting.** Bots are counted apart. A page view is a GET or HEAD answered 200 or 304 with an
  HTML content type. A visitor is a salted hash of address and user agent; raw addresses are never
  stored in the statistics. A visit ends after 30 quiet minutes. Unique visitors over any range come
  from merged HyperLogLog sketches (about 1.6% error), and the report says "about".
- **Storage.** Hourly rows, daily rows with the sketch, and daily top 500 values per dimension (the
  rest as "Other"). Written once a minute in one transaction. Retention is set per server: hourly
  7 to 365 days (default 90), daily 30 to 1825 days (default 730).
- **The app.** A Traffic section per Deploy server and a Traffic tab on each site: range and
  granularity, comparison with the period before, KPI tiles, the main chart, breakdowns, a world
  map, an hour-of-week heatmap, response times, live visitors and the settings.

## Tasks

- [x] T1 Log format in the renderer; golden files; system test that nginx takes it.
- [x] T2 Access log parser.
- [x] T3 User agent classifier; countries from Cloudflare and DB-IP; the monthly download.
- [x] T3b The app: Cloudflare geolocation and visitor location headers per site, turned on from the
  Traffic settings.
- [x] T4 HyperLogLog and the visit tracker.
- [x] T5 Aggregator and store; migration; retention.
- [x] T6 The tailer: offsets, rotation, truncation, restart, budget, off.
- [x] T7 Contracts, hub methods, roles, audit, mappers.
- [x] T8 DevHost traffic seeding.
- [x] T9 Desktop main: service, IPC, preload, fake core.
- [x] T10 Renderer: the Traffic section.
- [x] T11 End to end against the DevHost.
- [x] T12 Help article and docs.

## Desktop implementation notes

- **Main.** `main/deploy/traffic/service.ts` (`DeployTraffic`) wraps every traffic and attack hub
  method. Settings are checked with the form's own rules (`shared/deploy/trafficValidation.ts`, the
  core's limits) before the core hears of them; deleting statistics steps up for Admins, auto-block
  for Owners. A core without these methods ("Method does not exist") becomes "This server runs an
  older core without traffic statistics", which the section turns into an Update the core button.
  Live visitors (`main/deploy/traffic/live.ts`) ride the server's lasting link like the site logs:
  each stream belongs to the window that opened it, two per server, and reopens on a new connection.
- **IPC.** `main/ipc/deployTraffic.ts` (main window only; ids, ranges up to six years, enum values,
  list and text sizes), `preload/deployTraffic.ts`, `IPC.deployTraffic`, types in
  `shared/deployTrafficTypes.ts`. Registered at startup in `main/deploy/index.ts`; the service is
  also in `liveServices` for the phone (E111).
- **Shared helpers.** `shared/deploy/trafficFormat.ts` (1,284 / 12.9K, bytes, durations, changes,
  country names, "82% from Cloudflare, 18% from DB-IP"), `trafficRanges.ts` (ranges and buckets in
  the report's time zone, hours only within the hourly retention and up to 14 days) and
  `trafficValidation.ts`.
- **Fake core.** `shared/deploy/testing/fakeTraffic.ts`: deterministic reports that add up, paging
  and search behind "See all", settings, attacks and blocks; `FakeCoreConnection` answers every new
  hub method with the core's roles, and `trafficMissing` plays an older core.
- **Cloudflare (T3b).** `main/deploy/cloudflare/geolocation.ts` reads, per site on a zone this
  computer knows, the `ip_geolocation` zone setting and the `add_visitor_location_headers` Managed
  Transform (`/managed_headers`), and turns both on for a zone that holds one of the server's sites.
  Managed Transforms need a new optional token permission, Zone > Transform Rules > Edit
  (`transformRules`); without it the country still turns on and the error names what to add. Tested
  against the recorded fake, which now serves both endpoints. Not tried against the real API yet.
- **Renderer.** A Traffic section after Websites (`?view=traffic&traffic=<site>`), and a Traffic tab
  on each saved site that shows the same report with the site fixed. Everything lives in
  `components/deploy/traffic/`: the filter row (site, range chips with a custom range, buckets,
  comparison, live visitors), eight KPI tiles with change and sparkline, the visitors and page views
  chart with the period before dashed and a table view, breakdown cards with "See all" (paged and
  searched by the core), devices as a ring, a world choropleth with the country list, cities and
  the DB-IP credit, the hour-of-week heatmap, response times with status columns, and the
  settings dialog. Charts are hand-drawn SVG with keyboard readouts; colours come from
  `useChartColors` and the theme tokens. Reports refresh once a minute and keep the old one on
  screen, dimmed, while a new range loads.
- **World map.** `apps/desktop/scripts/build-world-map.mjs` turns world-atlas's 110m countries into
  `components/deploy/traffic/worldMap.json` (Equal Earth, paths keyed by ISO alpha-2, 174 countries,
  about 110 KB), loaded only when a report shows the map. `world-atlas`, `topojson-client` and
  `d3-geo` are devDependencies for the script alone.
- **End to end** (`apps/desktop/e2e/deployTraffic.e2e.ts`, steps shared in `e2e/devTraffic.ts`):
  two sites on the DevHost, statistics on in the Traffic settings, a week of visits seeded, then the
  tiles, chart, breakdowns, "See all", countries and map, ranges and buckets, the site picker, the
  site's own Traffic tab and statistics off again. Right after statistics come on, the core starts
  each log at its end on its next tick, so lines the DevHost writes before that tick are never
  counted; the spec writes one line at a time until the core has counted one, then seeds.
- **Help.** `src/shared/help/articles/deploy-traffic.md`; the core's value conventions (browsers
  without versions, Desktop, Mobile and Tablet, cities as "City, CC", T1, XX and "Other", the `*`
  all-sites id) are followed by the fake core and the report.

## Acceptance criteria

- AC1 Lines written to a site's access log show up in its report within a minute, in the right hour
  and day, with page views, visits, visitors and every breakdown counted as described.
- AC2 Turning statistics off stops every read of the logs; turning them on again continues.
- AC3 A rotated or truncated log loses no lines and counts none twice.
- AC4 A Cloudflare country header is used only from Cloudflare or the tunnel; a direct request
  that sends one is placed by DB-IP.
- AC5 No raw visitor address is stored in the statistics tables.
- AC6 A report over any range reads at most a few thousand rows.

## Core implementation notes

Everything lives in `apps/server-core/src/Runova.ServerCore/Traffic/`, with tests in
`tests/Runova.ServerCore.Tests/Traffic/` and `Mapping/TrafficMapperTests.cs`.

- **Log format.** `NginxRenderer` writes `log_format runova_main` at the http level (the name follows
  the layout's prefix, `TrafficLogFormat`) and every `access_log` of every site, the core's own
  included, uses it. The golden files changed with it. The nginx system tests (Debian 13 and Rocky 9
  in Docker) check that nginx takes the format and that the parser reads every field of a real line.
- **Parser** (`AccessLogParser`). Bytes and spans, no regular expressions, nginx's `\xHH` escapes kept
  until a field becomes text. Old `combined` lines parse with `Extended` false. A test counts the
  bytes allocated on its thread over 20,000 warm parses (none per line; a fixed kilobyte or so is
  the JIT), so it cannot flake.
- **User agents** (`UserAgentClassifier`). A table of our own, more specific names first (Edge,
  Opera, Samsung, Yandex and Vivaldi before Chrome, Chrome before Safari), bots by known names and
  then by hints (`bot/`, `crawler`, `+http`...), an empty agent counted as the bot "No user agent".
  Results sit in an LRU of 4096 keyed by XxHash64 of the agent's bytes. Breakdowns keep the browser's
  name without its version.
- **Countries** (`GeoCountry`). CF-IPCountry, CF-IPCity and CF-Region count only when
  `$realip_remote_addr` is loopback (the tunnel's cloudflared) or in Cloudflare's networks: the
  published list built in, replaced by the list the origin lock fetched (E14) when there is one.
  Codes are ISO alpha-2, `T1` for Tor and `XX` for unknown (Cloudflare's own codes); a Cloudflare
  `XX` gets a DB-IP lookup first. Cities are counted as "City, CC". DB-IP's file goes to
  `<data>/geo/dbip-country-lite.mmdb` (`GeoDatabaseUpdater`): checked a minute after start and every
  six hours while the logs are read with countries on, downloaded once a month, unpacked beside the
  old file, opened and checked, then moved over it; the month before is used until DB-IP publishes
  the new one, and a failed download keeps the old file and says why in `GeoDatabaseProblem`.
  MaxMind.Db 5.3.0 reads it into memory, with an LRU of 16,384 addresses in front. The tests build a
  tiny .mmdb themselves (`TestMmdb`). The DevHost never downloads it (its visitors come through
  Cloudflare's headers), and the test core uses a fake.
- **Visitors and visits.** A visitor is XxHash64 of a 32-byte salt kept in `<data>/traffic-salt`
  (owner-only), the address and the user agent. People who got an answer below 400 count as
  visitors, so a probe that finds nothing does not. Daily sketches are HyperLogLog (precision 12,
  4 KB, the input mixed once more so any id spreads); an hour's visitors are an estimate kept for the
  open hour, the larger of each flush. Visits follow `VisitTracker` (30 minutes, 100,000 open, oldest
  out); a visit counts in the hour and day it started, its bounce and length once it ends.
- **Storage** (`TrafficStore`, one combined migration `TrafficAndAttacks` for both epics). Every row
  is kept per site and under the site id `*` for all sites together, so a report reads the same few
  rows either way. Each day keeps its 500 most common values per dimension (the aggregator holds at
  most 5,000 per day in memory) and folds the rest into "Other". Page, entry page, referrer (the
  domain, other sites only), browser, system, device (Desktop, Mobile, Tablet), country and city
  count human page views; status codes count every request, bots included; Bot counts bot requests.
- **Reports.** Hours cover at most 31 days, any report at most three years. Weeks start on Monday and
  months on the first, in the report's time zone; the first bucket starts on that boundary, so it may
  begin before From. Totals, series and breakdowns come from the rows (breakdowns summed in SQL, top
  50); the hour-of-week heatmap is summed in SQL at the zone's offset at the range's end, so it is an
  hour off across a daylight saving change. Days are numbered in the zone of their first flush:
  changing the zone later leaves older days as they were.
- **Tailer** (`TrafficTailer`). Every 5 seconds, 256 KB chunks, 8 MB a tick, sites in turn. A file's
  first 64 bytes are its fingerprint; a log that shrank or changed its first bytes is finished from
  `.1` when that has the old fingerprint, then read from its start. If logrotate compresses at once
  (no `delaycompress`), the lines written after the last read are lost. Counts and offsets are written
  together once a minute. The core's own site is never read, and a site left out is not read at all
  (no detection either). Lines older than five minutes are kept out of the live view.
- **Turning it on and off.** Statistics, detection and auto-block are all off on a new core. The
  first time statistics come on, detection comes on too unless someone has set detection already;
  detection can run alone. From all off to on, the logs are read from their end; "read what the logs
  hold" (up to 200 MB a site) only counts the very first time statistics come on, since a later start
  would count lines twice. Statistics turned on while detection is running carry on from where
  detection has read. With both off nothing touches the logs. Retention is kept by
  `TrafficMaintenance` whether or not the logs are read: statistics and attack events past their
  retention go once a day, expired blocks every minute.
- **Deleting.** One site's statistics go from its rows; the all-sites rows keep what it added.
- **DevHost** (`Fakes/FakeTraffic.cs`, loopback only, `POST` with a JSON body):
  `/dev/sites/traffic` `{ "siteId": "blog", "count": 500, "daysBack": 7, "seed": 1 }` appends that
  many lines of whole visits (desktops, phones, tablets, bots, 14 places, 70% through Cloudflare with
  country and city, missing pages and errors) spread over the days before now (the last hour for 0)
  to the site's log, then has the tailer read and write them at once; it answers
  `{ "lines": 500 }`, 404 for no such site and 400 for a count over 200,000 or more than 400 days.
  Statistics must be on first. The simulated nginx now opens each site's access and error log when it
  loads a release, as nginx does.
