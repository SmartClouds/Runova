import type { IpcMainInvokeEvent } from 'electron';
import type {
  AttackKind,
  AttackThresholds,
  TrafficDimension,
  TrafficGranularity,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type {
  DeployAttackListInput,
  DeployAttackSettingsInput,
  DeployAutoBlockInput,
  DeployBlockInput,
  DeployTrafficDeleteInput,
  DeployTrafficDimensionInput,
  DeployTrafficLiveWatchInput,
  DeployTrafficReportInput,
  DeployTrafficSettingsInput,
  DeployUnblockInput,
} from '../../shared/deployTrafficTypes';
import { IPC } from '../../shared/ipcChannels';
import type { CloudflareGeolocation } from '../deploy/cloudflare/geolocation';
import type { SubscriptionOwner } from '../deploy/live/subscriptions';
import type { TrafficLiveSubscriptions } from '../deploy/traffic/live';
import type { DeployTraffic } from '../deploy/traffic/service';
import { type DeployIpcRegistry, object, serverId, stepUpInput } from './deploy';
import { bounded, flag, oneOf, siteId } from './deploySitesInput';

/**
 * The Traffic section's channels (E109, E110): reports, settings, attacks, blocking, live visitors
 * and Cloudflare's visitor location. Main window only, and every argument checked here for its
 * shape and size; what a value means (a retention the core does not allow, an address that is not
 * one) is checked by the service with the form's rules, and by the core again.
 */

export interface DeployTrafficHandlerDeps {
  ipc: DeployIpcRegistry;
  traffic: Pick<
    DeployTraffic,
    | 'status'
    | 'report'
    | 'dimension'
    | 'saveSettings'
    | 'deleteData'
    | 'attacks'
    | 'saveAttackSettings'
    | 'saveAutoBlock'
    | 'blocked'
    | 'block'
    | 'unblock'
  >;
  live: Pick<TrafficLiveSubscriptions, 'watch' | 'unwatch'>;
  geolocation: Pick<CloudflareGeolocation, 'status' | 'turnOn'>;
  /** True only for the main window's own frame. */
  guard: (event: IpcMainInvokeEvent) => boolean;
  /** The window behind a call, as the owner of the live views it opens. */
  owner: (event: IpcMainInvokeEvent) => SubscriptionOwner;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZONE_ID = /^[0-9a-f]{32}$/;
/** The core reports on at most three years (of 366 days) at a time. */
const MAX_SPAN_MS = 3 * 366 * 86_400_000;
const BIG = 1_000_000_000;
const MAX_SITES = 500;
const MAX_ALLOWLIST = 1000;
const MAX_NETWORK = 64;
const MAX_SEARCH = 200;
const MAX_REASON = 200;
const MAX_TIME_ZONE = 64;
const GRANULARITIES = [
  'hour',
  'day',
  'week',
  'month',
] as const satisfies readonly TrafficGranularity[];
const DIMENSIONS = [
  'page',
  'entryPage',
  'referrer',
  'browser',
  'operatingSystem',
  'device',
  'country',
  'city',
  'statusCode',
  'bot',
] as const satisfies readonly TrafficDimension[];
const ATTACK_KINDS = [
  'scan',
  'bruteForce',
  'flood',
  'injection',
] as const satisfies readonly AttackKind[];
const THRESHOLD_KEYS = [
  'scanProbes',
  'scanNotFound',
  'scanWindowMinutes',
  'bruteForceAttempts',
  'bruteForceWindowMinutes',
  'floodRequestsPerMinute',
  'injectionHits',
  'injectionWindowMinutes',
] as const satisfies readonly (keyof AttackThresholds)[];

function count(value: unknown, what: string, min = 0, max = BIG): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`The ${what} must be a whole number from ${min} to ${max}.`);
  }
  return value as number;
}

function time(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`The ${what} must be a moment in time.`);
  }
  return value as number;
}

/** A site, or null for every site. */
function maybeSite(value: unknown): string | null {
  return value === undefined || value === null ? null : siteId(value);
}

function range(input: Record<string, unknown>): { fromUnixMs: number; toUnixMs: number } {
  const fromUnixMs = time(input.fromUnixMs, 'start of the range');
  const toUnixMs = time(input.toUnixMs, 'end of the range');
  if (toUnixMs <= fromUnixMs) throw new Error('The range must end after it starts.');
  if (toUnixMs - fromUnixMs > MAX_SPAN_MS) throw new Error('That range is too long.');
  return { fromUnixMs, toUnixMs };
}

function list(value: unknown, max: number, what: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Give at most ${max} ${what}.`);
  return value;
}

export function reportInput(value: unknown): DeployTrafficReportInput {
  const input = object(value, 'a traffic report');
  const site = maybeSite(input.siteId);
  return {
    serverId: serverId(input.serverId),
    ...(site ? { siteId: site } : {}),
    ...range(input),
    granularity: oneOf(input.granularity, GRANULARITIES, 'granularity'),
    compare: flag(input.compare, 'comparing with the period before'),
  };
}

function dimensionInput(value: unknown): DeployTrafficDimensionInput {
  const input = object(value, 'a breakdown page');
  const site = maybeSite(input.siteId);
  const search =
    input.search === undefined || input.search === null || input.search === ''
      ? undefined
      : bounded(input.search, MAX_SEARCH, 'search');
  return {
    serverId: serverId(input.serverId),
    ...(site ? { siteId: site } : {}),
    ...range(input),
    dimension: oneOf(input.dimension, DIMENSIONS, 'breakdown'),
    offset: count(input.offset, 'offset', 0, 1_000_000),
    limit: count(input.limit, 'page size', 1, 500),
    ...(search ? { search } : {}),
  };
}

function settingsInput(value: unknown): DeployTrafficSettingsInput {
  const input = object(value, 'traffic settings');
  const settings = object(input.settings, 'traffic settings');
  return {
    serverId: serverId(input.serverId),
    settings: {
      enabled: flag(settings.enabled, 'statistics'),
      countries: flag(settings.countries, 'countries'),
      excludedSites: list(settings.excludedSites, MAX_SITES, 'sites').map((site) => siteId(site)),
      hourlyRetentionDays: count(settings.hourlyRetentionDays, 'hourly retention'),
      dailyRetentionDays: count(settings.dailyRetentionDays, 'daily retention'),
      timeZone: bounded(settings.timeZone, MAX_TIME_ZONE, 'time zone'),
      readExistingLogs:
        settings.readExistingLogs === undefined
          ? false
          : flag(settings.readExistingLogs, 'reading the logs already there'),
    },
  };
}

function deleteInput(value: unknown): DeployTrafficDeleteInput {
  const input = object(value, 'what to delete');
  return { ...stepUpInput(value), siteId: maybeSite(input.siteId) };
}

function attackListInput(value: unknown): DeployAttackListInput {
  const input = object(value, 'an attack query');
  const site = maybeSite(input.siteId);
  return {
    serverId: serverId(input.serverId),
    ...(site ? { siteId: site } : {}),
    ...(input.fromUnixMs === undefined ? {} : { fromUnixMs: time(input.fromUnixMs, 'start') }),
    ...(input.toUnixMs === undefined ? {} : { toUnixMs: time(input.toUnixMs, 'end') }),
    limit: count(input.limit, 'limit', 1, 1000),
  };
}

function attackSettingsInput(value: unknown): DeployAttackSettingsInput {
  const input = object(value, 'detection settings');
  const settings = object(input.settings, 'detection settings');
  const given = object(settings.thresholds, 'thresholds');
  const thresholds = Object.fromEntries(
    THRESHOLD_KEYS.map((key) => [key, count(given[key], 'threshold')]),
  ) as unknown as AttackThresholds;
  return {
    serverId: serverId(input.serverId),
    settings: {
      enabled: flag(settings.enabled, 'detection'),
      thresholds,
      allowlist: list(settings.allowlist, MAX_ALLOWLIST, 'allowlist entries').map((entry) =>
        bounded(entry, MAX_NETWORK, 'allowlist entry'),
      ),
      eventRetentionDays: count(settings.eventRetentionDays, 'event retention'),
    },
  };
}

function autoBlockInput(value: unknown): DeployAutoBlockInput {
  const input = object(value, 'auto-block settings');
  const settings = object(input.settings, 'auto-block settings');
  return {
    ...stepUpInput(value),
    settings: {
      enabled: flag(settings.enabled, 'auto-block'),
      kinds: list(settings.kinds, ATTACK_KINDS.length, 'kinds').map((kind) =>
        oneOf(kind, ATTACK_KINDS, 'kind of attack'),
      ),
      minutes: count(settings.minutes, 'block length'),
      maxBlocked: count(settings.maxBlocked, 'cap'),
    },
  };
}

function blockInput(value: unknown): DeployBlockInput {
  const input = object(value, 'an address to block');
  const site = maybeSite(input.siteId);
  return {
    serverId: serverId(input.serverId),
    network: bounded(input.network, MAX_NETWORK, 'address'),
    ...(input.reason === undefined || input.reason === null || input.reason === ''
      ? {}
      : { reason: bounded(input.reason, MAX_REASON, 'reason') }),
    ...(input.minutes === undefined || input.minutes === null
      ? {}
      : { minutes: count(input.minutes, 'block length', 0, 525_600) }),
    ...(site ? { siteId: site } : {}),
  };
}

function unblockInput(value: unknown): DeployUnblockInput {
  const input = object(value, 'a block to lift');
  return {
    serverId: serverId(input.serverId),
    blockId: count(input.blockId, 'block', 1, Number.MAX_SAFE_INTEGER),
  };
}

function liveInput(value: unknown): DeployTrafficLiveWatchInput {
  const input = object(value, 'a live view');
  return { serverId: serverId(input.serverId), siteId: maybeSite(input.siteId) };
}

function subscription(value: unknown): string {
  if (typeof value !== 'string' || !GUID.test(value)) {
    throw new Error('That is not a subscription.');
  }
  return value;
}

function zoneInput(value: unknown): { serverId: string; zoneId: string } {
  const input = object(value, 'a Cloudflare zone');
  if (typeof input.zoneId !== 'string' || !ZONE_ID.test(input.zoneId)) {
    throw new Error('That is not a Cloudflare zone.');
  }
  return { serverId: serverId(input.serverId), zoneId: input.zoneId };
}

export function registerDeployTrafficHandlers(deps: DeployTrafficHandlerDeps): void {
  const { ipc, traffic, live, geolocation } = deps;
  const handle = (
    channel: string,
    run: (owner: () => SubscriptionOwner, ...args: unknown[]) => unknown,
  ) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!deps.guard(event)) throw new Error('Deploy is only available in the main window.');
      return run(() => deps.owner(event), ...args);
    });
  };

  handle(IPC.deployTraffic.status, (_owner, id) => traffic.status(serverId(id)));
  handle(IPC.deployTraffic.report, (_owner, value) => traffic.report(reportInput(value)));
  handle(IPC.deployTraffic.dimension, (_owner, value) => traffic.dimension(dimensionInput(value)));
  handle(IPC.deployTraffic.saveSettings, (_owner, value) =>
    traffic.saveSettings(settingsInput(value)),
  );
  handle(IPC.deployTraffic.deleteData, (_owner, value) => traffic.deleteData(deleteInput(value)));
  handle(IPC.deployTraffic.attacks, (_owner, value) => traffic.attacks(attackListInput(value)));
  handle(IPC.deployTraffic.saveAttackSettings, (_owner, value) =>
    traffic.saveAttackSettings(attackSettingsInput(value)),
  );
  handle(IPC.deployTraffic.saveAutoBlock, (_owner, value) =>
    traffic.saveAutoBlock(autoBlockInput(value)),
  );
  handle(IPC.deployTraffic.blocked, (_owner, id) => traffic.blocked(serverId(id)));
  handle(IPC.deployTraffic.block, (_owner, value) => traffic.block(blockInput(value)));
  handle(IPC.deployTraffic.unblock, (_owner, value) => traffic.unblock(unblockInput(value)));
  handle(IPC.deployTraffic.watchLive, (owner, value) => live.watch(owner(), liveInput(value)));
  handle(IPC.deployTraffic.unwatchLive, (owner, id) => live.unwatch(owner(), subscription(id)));
  handle(IPC.deployTraffic.geolocation, (_owner, id) => geolocation.status(serverId(id)));
  handle(IPC.deployTraffic.turnOnGeolocation, (_owner, value) => {
    const { serverId: id, zoneId } = zoneInput(value);
    return geolocation.turnOn(id, zoneId);
  });
}

/** The same checks for the phone's bridge (E111), so neither way in takes what the other refuses. */
export const deployTrafficInputs = { dimensionInput, attackListInput, blockInput, unblockInput };
