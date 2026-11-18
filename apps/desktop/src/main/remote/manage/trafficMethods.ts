import type {
  AttackEventInfo,
  BlockedAddressInfo,
  TrafficCount,
  TrafficGranularity,
  TrafficPoint,
  TrafficStatus,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { catchAllsLast, comparison } from '../../../shared/deploy/trafficCompare';
import { countryName, sourcesText } from '../../../shared/deploy/trafficFormat';
import {
  axisLabel,
  bucketLabel,
  DAY_MS,
  defaultGranularity,
  fitGranularity,
  granularityChoices,
  rangeWindow,
  type TrafficRange,
} from '../../../shared/deploy/trafficRanges';
import { attackKindLabel } from '../../../shared/deploy/trafficValidation';
import type { DeployAccess } from '../../../shared/deployTypes';
import type { DeployTraffic } from '../../deploy/traffic/service';
import { serverId as checkServer } from '../../ipc/deploy';
import { siteId as checkSite, flag, oneOf } from '../../ipc/deploySitesInput';
import { deployTrafficInputs as inputs, reportInput } from '../../ipc/deployTraffic';
import { roleOf } from './cloudflareOriginMethods';
import { ManageError, type ManageMethods } from './session';

/** What the phone's traffic screens need from the rest of the app. */
export interface ManageTrafficDeps {
  access(serverId: string): Promise<DeployAccess>;
  traffic: Pick<
    DeployTraffic,
    | 'status'
    | 'report'
    | 'dimension'
    | 'saveSettings'
    | 'saveAttackSettings'
    | 'attacks'
    | 'blocked'
    | 'block'
    | 'unblock'
  >;
  now(): number;
}

const RANGES = ['today', '7d', '30d', '90d', '12m'] as const satisfies readonly TrafficRange[];
const GRANULARITIES = [
  'hour',
  'day',
  'week',
  'month',
] as const satisfies readonly TrafficGranularity[];
/** A breakdown on the phone shows this many rows; "See all" pages through the rest. */
const TOP_ROWS = 8;
const PAGE = 50;
const ATTACK_DAYS = 7;
const ATTACK_LIMIT = 50;
const SAMPLE_PATHS = 3;
const PHONE_REASON = 'Blocked from the phone';

function field(params: unknown, name: string): unknown {
  return (params as Record<string, unknown> | null | undefined)?.[name];
}

/** Runs an input check and turns its complaint into the phone's bad-params answer. */
function checked<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new ManageError('bad-params', (error as Error).message);
  }
}

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ManageError) throw error;
    throw new ManageError('failed', (error as Error).message);
  }
}

const serverOf = (params: unknown) => checked(() => checkServer(field(params, 'serverId')));

function siteOf(params: unknown): string | null {
  const value = field(params, 'siteId');
  return value === undefined || value === null ? null : checked(() => checkSite(value));
}

function whole(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`The ${what} must be a whole number.`);
  return value as number;
}

/** A country code with its name, so the phone needs no table of its own. */
function named(dimension: string, count: TrafficCount) {
  return dimension === 'country' ? { ...count, name: countryName(count.value) } : count;
}

function zoneOf(status: TrafficStatus): string {
  return status.settings.timeZone || status.defaultTimeZone || 'UTC';
}

function point(p: TrafficPoint) {
  return { visitors: p.visitors, pageViews: p.pageViews };
}

function attackView(event: AttackEventInfo) {
  return {
    id: event.id,
    siteId: event.siteId,
    kind: event.kind,
    kindLabel: attackKindLabel(event.kind),
    address: event.address,
    country: event.country ?? null,
    countryName: event.country ? countryName(event.country) : null,
    firstSeen: event.firstSeenAtUnixMs,
    lastSeen: event.lastSeenAtUnixMs,
    count: event.count,
    samplePaths: event.samplePaths.slice(0, SAMPLE_PATHS),
    blocked: event.blocked,
  };
}

function blockedView(block: BlockedAddressInfo) {
  return {
    id: block.id,
    network: block.network,
    reason: block.reason,
    automatic: block.automatic,
    createdAt: block.createdAtUnixMs,
    siteId: block.siteId ?? null,
    createdBy: block.createdBy ?? null,
    expiresAt: block.expiresAtUnixMs ?? null,
  };
}

/** Throws the core's (or the form's) own words when a save was refused. */
function saved(result: { problems: string[] }): void {
  if (result.problems.length > 0) throw new ManageError('bad-params', result.problems.join(' '));
}

/**
 * Website traffic and attacks for a phone (E111), through the desktop's own traffic service and
 * the checks its IPC makes. The phone names a preset range and this computer works out the window
 * in the report's time zone, with the desktop's own rules for which buckets fit, so both apps count
 * the same days. Breakdowns come capped to what the phone shows. The phone only ever sends an
 * address to block, checked here as on the computer; the core writes the nginx side. Auto-block and
 * deleting statistics take a step-up and stay on the computer.
 */
export function trafficMethods(deps: ManageTrafficDeps): ManageMethods['calls'] {
  const { traffic } = deps;
  return {
    'deploy.traffic': async (params) => {
      const id = serverOf(params);
      const site = siteOf(params);
      const range = checked(() => oneOf(field(params, 'range'), RANGES, 'range'));
      const picked = field(params, 'granularity');
      const asked =
        picked === undefined || picked === null
          ? null
          : checked(() => oneOf(picked, GRANULARITIES, 'granularity'));
      const [access, status] = await run(() => Promise.all([deps.access(id), traffic.status(id)]));
      const now = deps.now();
      const zone = zoneOf(status);
      const window = rangeWindow(range, now, zone);
      const choices = granularityChoices(window, now, status.settings.hourlyRetentionDays);
      const preferred = defaultGranularity(range, window.to - window.from);
      const granularity = fitGranularity(asked ?? preferred, choices, preferred);
      const input = checked(() =>
        reportInput({
          serverId: id,
          ...(site ? { siteId: site } : {}),
          fromUnixMs: window.from,
          toUnixMs: window.to,
          granularity,
          compare: true,
        }),
      );
      const report = await run(() => traffic.report(input));
      const timeZone = report.timeZone || zone;
      // The period before only where statistics were counted, as the desktop draws it.
      const compared = comparison(report);
      const firstPrevious = compared.firstPrevious;
      return {
        role: roleOf(access),
        siteId: site,
        range,
        granularity,
        granularities: choices.map(({ value, label, enabled, reason }) => ({
          value,
          label,
          enabled,
          reason: reason ?? null,
        })),
        fromUnixMs: window.from,
        toUnixMs: window.to,
        timeZone,
        enabled: report.enabled,
        collectingSince: report.collectingSinceUnixMs ?? null,
        sites: status.sites.map((s) => ({ id: s.siteId, label: s.domains[0] ?? s.siteId })),
        totals: report.totals,
        previous: compared.changes ? (report.previous ?? null) : null,
        noEarlierData: compared.reason === 'noData',
        series: report.series.map((p) => ({
          at: p.startUnixMs,
          axis: axisLabel(p.startUnixMs, granularity, timeZone),
          label: bucketLabel(p.startUnixMs, granularity, timeZone),
          ...point(p),
        })),
        previousSeries:
          firstPrevious === null
            ? []
            : (report.previousSeries ?? []).map((p, index) =>
                index < firstPrevious ? null : point(p),
              ),
        breakdowns: report.breakdowns.map((b) => ({
          dimension: b.dimension,
          total: b.total,
          top: catchAllsLast(b.top.slice(0, TOP_ROWS), b.dimension).map((count) =>
            named(b.dimension, count),
          ),
        })),
        countrySources: sourcesText(report.countrySources),
      };
    },
    'deploy.trafficDimension': async (params) => {
      const input = checked(() =>
        inputs.dimensionInput({ ...(params as object), limit: PAGE, search: undefined }),
      );
      const page = await run(() => traffic.dimension(input));
      return {
        dimension: page.dimension,
        total: page.total,
        totalItems: page.totalItems,
        items: catchAllsLast(page.items, page.dimension).map((count) =>
          named(page.dimension, count),
        ),
      };
    },
    'deploy.trafficStatus': async (params) => {
      const id = serverOf(params);
      const [access, status] = await run(() => Promise.all([deps.access(id), traffic.status(id)]));
      return {
        role: roleOf(access),
        statistics: {
          enabled: status.settings.enabled,
          countries: status.settings.countries,
          hourlyRetentionDays: status.settings.hourlyRetentionDays,
          dailyRetentionDays: status.settings.dailyRetentionDays,
        },
        detection: { enabled: status.attacks.enabled },
        autoBlock: {
          enabled: status.autoBlock.enabled,
          kinds: status.autoBlock.kinds,
          minutes: status.autoBlock.minutes,
        },
        geoDatabaseReady: status.geoDatabaseReady,
        storageBytes: status.storageBytes,
        changedAt: status.changedAtUnixMs ?? null,
        changedBy: status.changedBy ?? null,
      };
    },
    'deploy.trafficSaveSettings': async (params) => {
      const id = serverOf(params);
      const statistics = field(params, 'statistics') as Record<string, unknown> | undefined;
      const detection = field(params, 'detection') as Record<string, unknown> | undefined;
      const change = checked(() => ({
        enabled:
          statistics?.enabled === undefined ? undefined : flag(statistics.enabled, 'statistics'),
        countries:
          statistics?.countries === undefined ? undefined : flag(statistics.countries, 'countries'),
        hourly:
          statistics?.hourlyRetentionDays === undefined
            ? undefined
            : whole(statistics.hourlyRetentionDays, 'hourly retention'),
        daily:
          statistics?.dailyRetentionDays === undefined
            ? undefined
            : whole(statistics.dailyRetentionDays, 'daily retention'),
        detection:
          detection?.enabled === undefined ? undefined : flag(detection.enabled, 'detection'),
      }));
      const status = await run(() => traffic.status(id));
      if (statistics) {
        const now = status.settings;
        const result = await run(() =>
          traffic.saveSettings({
            serverId: id,
            settings: {
              enabled: change.enabled ?? now.enabled,
              countries: change.countries ?? now.countries,
              excludedSites: now.excludedSites,
              hourlyRetentionDays: change.hourly ?? now.hourlyRetentionDays,
              dailyRetentionDays: change.daily ?? now.dailyRetentionDays,
              timeZone: zoneOf(status),
              readExistingLogs: false,
            },
          }),
        );
        saved(result);
      }
      if (change.detection !== undefined) {
        const detect = change.detection;
        const result = await run(() =>
          traffic.saveAttackSettings({
            serverId: id,
            settings: { ...status.attacks, enabled: detect },
          }),
        );
        saved(result);
      }
      return { ok: true, message: 'Saved.' };
    },
    'deploy.trafficAttacks': async (params) => {
      const now = deps.now();
      const site = siteOf(params);
      const input = checked(() =>
        inputs.attackListInput({
          serverId: field(params, 'serverId'),
          ...(site ? { siteId: site } : {}),
          fromUnixMs: now - ATTACK_DAYS * DAY_MS,
          toUnixMs: now,
          limit: ATTACK_LIMIT,
        }),
      );
      const summary = await run(() => traffic.attacks(input));
      return {
        events: summary.events.slice(0, ATTACK_LIMIT).map(attackView),
        series: summary.series,
        addresses: summary.addresses,
        blocked: summary.blocked,
      };
    },
    'deploy.trafficBlocked': async (params) => {
      const id = serverOf(params);
      return (await run(() => traffic.blocked(id))).map(blockedView);
    },
    'deploy.trafficBlock': async (params) => {
      const site = siteOf(params);
      const input = checked(() =>
        inputs.blockInput({
          serverId: field(params, 'serverId'),
          network: field(params, 'network'),
          ...(site ? { siteId: site } : {}),
          reason: PHONE_REASON,
        }),
      );
      const result = await run(() => traffic.block(input));
      saved(result);
      const network = result.blocked?.network ?? input.network.trim();
      return {
        ok: true,
        message: `Blocked ${network}. nginx refuses it on every site on this server.`,
      };
    },
    'deploy.trafficUnblock': async (params) => {
      const input = checked(() => inputs.unblockInput(params));
      await run(() => traffic.unblock(input));
      return { ok: true, message: 'Unblocked. nginx answers that address again.' };
    },
  };
}
