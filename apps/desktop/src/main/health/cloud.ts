import {
  cloudSecretFor,
  cloudUrlProblem,
  type HealthHourBucket,
  type HealthIncident,
  type HealthProbeState,
  type HealthReport,
  type HealthSample,
  healthHoursFromSamples,
  INITIAL_HEALTH_TRACK,
} from '@runova/core';
import type {
  HealthCloudEnableInput,
  HealthCloudInfo,
  HealthCloudPlan,
  HealthCloudSettingsPatch,
  HealthRunMode,
} from '../../shared/healthTypes';
import {
  HEALTH_MAX_INCIDENTS,
  HEALTH_MAX_SAMPLES,
  type HealthResultRecord,
  type StoredHealthTarget,
} from './store';

/**
 * Monitors that run on Runova Cloud (E56). The server's nodes check them, so this computer never
 * does: it turns a monitor online (with the person's consent for the key), changes it, turns it
 * back, and shows what the server found. It keeps the server's monitors and, per monitor, a short
 * history, and keeps both current from the notifications hub: each `CloudMonitorUpdated` moves a
 * card within a second, and `CloudMonitorsChanged` reads the list again.
 */

export interface CloudIncidentDto {
  id: number;
  monitorId: number;
  openedAt: string;
  resolvedAt: string | null;
  state: string;
  problem: string | null;
  region: string | null;
  confirmedFrom: string | null;
}

export interface CloudStatusDto {
  verdict: 'up' | 'down' | 'degraded' | 'paused' | 'unknown';
  state: string | null;
  lastCheckedAt: string | null;
  latencyMs: number | null;
  httpStatus: number | null;
  problem: string | null;
  region: string | null;
  confirming: boolean;
  openIncident: CloudIncidentDto | null;
  uptime24h: number | null;
}

export interface CloudMonitorDto {
  id: number;
  scopeId: number;
  itemId: string;
  name: string;
  url: string;
  intervalSec: number;
  paused: boolean;
  suspendedReason: string | null;
  notifyInApp: boolean;
  notifyTelegram: boolean;
  muted: boolean;
  canWrite: boolean;
  status: CloudStatusDto;
  version: string;
}

export interface CloudMonitorLive {
  id: number;
  scopeId: number;
  itemId: string;
  paused: boolean;
  status: CloudStatusDto;
}

interface CloudSampleDto {
  at: string;
  state: string;
  latencyMs: number | null;
}

interface CloudHourDto {
  hour: string;
  checks: number;
  failures: number;
  avgLatencyMs: number | null;
  maxLatencyMs: number | null;
}

interface ScopeUsageDto {
  scopeId: number;
  name: string;
  canWrite: boolean;
  accountTypeName: string;
  maxMonitors: number | null;
  minIntervalSec: number;
  active: number;
}

/** The fields of a monitor the server keeps a copy of. */
export type CloudDefinitionPatch = Partial<{
  name: string;
  projectName: string;
  environmentName: string | null;
  url: string;
  intervalSec: number;
  timeoutSec: number;
  allowInsecure: boolean;
  paused: boolean;
  notifyInApp: boolean;
  notifyTelegram: boolean;
}>;

export interface CloudMonitorsDeps {
  api: <T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { headers?: Record<string, string> },
  ) => Promise<T>;
  signedIn: () => Promise<boolean>;
  /** The scope the project lives in now, or null when it is not synced. */
  placement: (projectId: string) => Promise<{ scopeId: number; canWrite: boolean } | null>;
  names: (
    target: StoredHealthTarget,
  ) => Promise<{ projectName: string; environmentName: string | null }>;
  /** The plaintext key (or the Basic password), or null when there is none or the vault is locked. */
  openSecret: (target: StoredHealthTarget) => Promise<string | null>;
  targets: () => Promise<StoredHealthTarget[]>;
  /** Writes the run mode into the stored (and synced) monitor. */
  setRunMode: (
    targetId: string,
    mode: HealthRunMode,
    cloudMonitorId: number | null,
  ) => Promise<void>;
  /** Tells the windows these monitors changed. */
  changed: (targetIds: string[]) => void;
  now?: () => number;
  log?: (message: string) => void;
}

interface History {
  samples: HealthSample[];
  hours: HealthHourBucket[];
  incidents: HealthIncident[];
}

const PROBE_STATES: readonly HealthProbeState[] = [
  'pass',
  'warn',
  'fail',
  'unreachable',
  'unauthorized',
  'invalid',
];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function probeState(value: string | null | undefined): HealthProbeState | null {
  return PROBE_STATES.includes(value as HealthProbeState) ? (value as HealthProbeState) : null;
}

function ms(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "1 online monitor", "10 online monitors". */
function monitors(count: number): string {
  return count === 1 ? '1 online monitor' : `${count} online monitors`;
}

/** The message of a problem from the server, or of anything else that went wrong. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusOf(error: unknown): number | null {
  const problem = (error as { problem?: { status?: number } } | null)?.problem;
  return typeof problem?.status === 'number' ? problem.status : null;
}

export function toIncident(targetId: string, incident: CloudIncidentDto): HealthIncident {
  return {
    id: `cloud:${incident.id}`,
    targetId,
    openedAt: ms(incident.openedAt) ?? 0,
    resolvedAt: ms(incident.resolvedAt),
    state: probeState(incident.state) ?? 'fail',
    summary: incident.problem ?? (incident.region ? `Down, seen from ${incident.region}` : 'Down'),
    failingServices: [],
    diagnosis: null,
  };
}

/** The last result as the page's report: the server keeps no services or body, only the line. */
function reportOf(status: CloudStatusDto): HealthReport | null {
  const state = probeState(status.state);
  const checkedAt = ms(status.lastCheckedAt);
  if (!state || checkedAt === null) return null;
  return {
    state,
    httpStatus: status.httpStatus,
    latencyMs: status.latencyMs,
    checkedAt,
    serviceId: null,
    description: null,
    releaseId: null,
    version: null,
    output: null,
    services: [],
    problem: state === 'pass' ? null : status.problem,
    raw: null,
  };
}

export function createCloudMonitors(deps: CloudMonitorsDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const byId = new Map<number, CloudMonitorDto>();
  const histories = new Map<number, History>();
  let signedIn = false;
  let loaded = false;

  async function cloudTargets(): Promise<StoredHealthTarget[]> {
    return (await deps.targets()).filter((target) => target.runMode === 'cloud');
  }

  /** The server's copy of a target: by its id, or by the desktop monitor it names. */
  function monitorOf(target: StoredHealthTarget): CloudMonitorDto | null {
    if (target.cloudMonitorId && byId.has(target.cloudMonitorId)) {
      return byId.get(target.cloudMonitorId) ?? null;
    }
    for (const monitor of byId.values()) if (monitor.itemId === target.id) return monitor;
    return null;
  }

  async function announce(predicate: (target: StoredHealthTarget) => boolean): Promise<void> {
    deps.changed((await cloudTargets()).filter(predicate).map((target) => target.id));
  }

  async function refresh(): Promise<void> {
    signedIn = await deps.signedIn();
    if (!signedIn) {
      byId.clear();
      histories.clear();
      loaded = false;
      await announce(() => true);
      return;
    }
    const list = await deps.api<{ items: CloudMonitorDto[] }>('GET', '/cloud-monitors');
    byId.clear();
    for (const monitor of list.items) byId.set(monitor.id, monitor);
    for (const id of [...histories.keys()]) if (!byId.has(id)) histories.delete(id);
    loaded = true;
    await announce(() => true);
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    try {
      await refresh();
    } catch (error) {
      log(`[cloud-monitors] reading the online monitors failed: ${messageOf(error)}`);
    }
  }

  async function history(monitor: CloudMonitorDto, targetId: string): Promise<History> {
    const known = histories.get(monitor.id);
    if (known) return known;
    const [samples, hours, incidents] = await Promise.all([
      deps.api<{ items: CloudSampleDto[] }>('GET', `/cloud-monitors/${monitor.id}/samples`),
      deps.api<{ items: CloudHourDto[] }>('GET', `/cloud-monitors/${monitor.id}/hours`),
      deps.api<{ items: CloudIncidentDto[] }>(
        'GET',
        `/cloud-monitors/${monitor.id}/incidents?pageSize=${HEALTH_MAX_INCIDENTS}`,
      ),
    ]);
    const kept: History = {
      samples: samples.items
        .map((one) => ({
          at: ms(one.at) ?? 0,
          state: probeState(one.state) ?? 'fail',
          latencyMs: one.latencyMs,
        }))
        .slice(-HEALTH_MAX_SAMPLES),
      hours: hours.items.map((one) => ({
        start: ms(one.hour) ?? 0,
        checks: one.checks,
        failures: one.failures,
        p50: one.avgLatencyMs,
        p95: one.maxLatencyMs,
      })),
      incidents: incidents.items.map((one) => toIncident(targetId, one)),
    };
    histories.set(monitor.id, kept);
    return kept;
  }

  /**
   * The server's results in the shape the page reads for a local monitor. The last day's hours
   * come from the samples, so the latency chart has real percentiles; older ones from the hours.
   */
  function record(
    monitor: CloudMonitorDto,
    kept: History | null,
    targetId: string,
  ): HealthResultRecord {
    const status = monitor.status;
    const samples = kept?.samples ?? [];
    const dayAgo = now() - DAY_MS;
    const recent = healthHoursFromSamples(samples.filter((one) => one.at >= dayAgo));
    const older = (kept?.hours ?? []).filter((one) => one.start < dayAgo);
    const open = status.openIncident ? toIncident(targetId, status.openIncident) : null;
    const lastCheckedAt = ms(status.lastCheckedAt);
    // The history may hold an incident from before it was resolved; the status knows better.
    const incidents = (kept?.incidents ?? []).map((one) =>
      one.resolvedAt === null && one.id !== open?.id
        ? { ...one, resolvedAt: lastCheckedAt ?? now() }
        : one,
    );
    if (open && !incidents.some((one) => one.id === open.id)) incidents.unshift(open);
    return {
      report: reportOf(status),
      samples,
      hours: [...older, ...recent].sort((a, b) => a.start - b.start),
      track: { ...INITIAL_HEALTH_TRACK, pending: status.confirming },
      incidents,
      lastCheckedAt,
      nextCheckAt: lastCheckedAt === null ? null : lastCheckedAt + monitor.intervalSec * 1000,
    };
  }

  async function findTarget(targetId: string): Promise<StoredHealthTarget> {
    const target = (await deps.targets()).find((one) => one.id === targetId);
    if (!target) throw new Error('That healthcheck no longer exists.');
    return target;
  }

  function ifMatch(monitor: CloudMonitorDto | null): Record<string, string> {
    return { 'if-match': monitor ? `"${monitor.version}"` : '*' };
  }

  async function patchMonitor(
    target: StoredHealthTarget,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const monitor = monitorOf(target) ?? (await ensureLoaded(), monitorOf(target));
    if (!monitor)
      throw new Error('This monitor is not on Runova Cloud any more. Turn it online again.');
    // Only the fields just changed are sent, so the newest copy wins, as with the alert settings.
    const updated = await deps.api<CloudMonitorDto>(
      'PATCH',
      `/cloud-monitors/${monitor.id}`,
      patch,
      {
        headers: { 'if-match': '*' },
      },
    );
    byId.set(updated.id, updated);
    deps.changed([target.id]);
  }

  return {
    refresh,

    /** A result from the hub: the card moves at once, and the history grows by it. */
    async live(update: CloudMonitorLive): Promise<void> {
      const monitor = byId.get(update.id);
      if (!monitor) {
        await refresh().catch((error: unknown) => log(`[cloud-monitors] ${messageOf(error)}`));
        return;
      }
      const previous = monitor.status.lastCheckedAt;
      byId.set(update.id, { ...monitor, paused: update.paused, status: update.status });
      const kept = histories.get(update.id);
      const state = probeState(update.status.state);
      const at = ms(update.status.lastCheckedAt);
      if (kept && state && at !== null && update.status.lastCheckedAt !== previous) {
        kept.samples = [...kept.samples, { at, state, latencyMs: update.status.latencyMs }].slice(
          -HEALTH_MAX_SAMPLES,
        );
        const open = update.status.openIncident;
        if (open && !kept.incidents.some((one) => one.id === `cloud:${open.id}`)) {
          kept.incidents = [toIncident(update.itemId, open), ...kept.incidents].slice(
            0,
            HEALTH_MAX_INCIDENTS,
          );
        }
        if (!open) {
          kept.incidents = kept.incidents.map((one) =>
            one.resolvedAt === null ? { ...one, resolvedAt: at } : one,
          );
        }
      }
      await announce(
        (target) => target.id === update.itemId || target.cloudMonitorId === update.id,
      );
    },

    /** Signed out: nothing to show, and nothing kept. */
    async reset(): Promise<void> {
      signedIn = false;
      loaded = false;
      byId.clear();
      histories.clear();
      await announce(() => true);
    },

    /** What the page shows for a cloud monitor, or null for a local one. */
    info(target: StoredHealthTarget): HealthCloudInfo | null {
      if (target.runMode !== 'cloud') return null;
      const monitor = monitorOf(target);
      return {
        monitorId: monitor?.id ?? target.cloudMonitorId ?? null,
        signedIn,
        region: monitor?.status.region ?? null,
        suspendedReason: monitor?.suspendedReason ?? null,
        notifyInApp: monitor?.notifyInApp ?? true,
        notifyTelegram: monitor?.notifyTelegram ?? false,
        muted: monitor?.muted ?? false,
        canWrite: monitor?.canWrite ?? true,
        confirming: monitor?.status.confirming ?? false,
      };
    },

    /** Paused on the server (by a person or by the account type) shows as paused here. */
    paused(target: StoredHealthTarget): boolean {
      return monitorOf(target)?.paused ?? target.paused;
    },

    /** The server's results, or undefined while there are none to show. */
    async result(
      target: StoredHealthTarget,
      withHistory: boolean,
    ): Promise<HealthResultRecord | undefined> {
      if (target.runMode !== 'cloud') return undefined;
      await ensureLoaded();
      const monitor = monitorOf(target);
      if (!monitor) return undefined;
      let kept = histories.get(monitor.id) ?? null;
      if (!kept && withHistory) {
        kept = await history(monitor, target.id).catch((error: unknown) => {
          log(`[cloud-monitors] reading the history failed: ${messageOf(error)}`);
          return null;
        });
      }
      return record(monitor, kept, target.id);
    },

    /** "Where it runs": the scope's account type and use, and what stands in the way. */
    async plan(targetOrProject: {
      projectId: string;
      url?: string;
      allowInsecure?: boolean;
      runMode?: HealthRunMode;
    }): Promise<HealthCloudPlan> {
      const empty: HealthCloudPlan = {
        signedIn: false,
        scopeName: null,
        canWrite: false,
        accountTypeName: null,
        maxMonitors: null,
        active: 0,
        minIntervalSec: 300,
        blocked: 'Sign in to your Runova account to check this monitor from Runova Cloud.',
        action: 'sign-in',
        telegramLinked: false,
      };
      if (!(await deps.signedIn())) return empty;
      const placement = await deps.placement(targetOrProject.projectId);
      if (!placement) {
        return {
          ...empty,
          signedIn: true,
          action: null,
          blocked:
            'This project is not synced to your account yet. Sync it first, then turn the monitor online.',
        };
      }
      const [usage, link] = await Promise.all([
        deps.api<{ scopes: ScopeUsageDto[] }>('GET', '/cloud-monitors/usage'),
        deps
          .api<{ linked: boolean } | null>('GET', '/accounts/me/telegram-links/current')
          .catch(() => null),
      ]);
      const scope = usage.scopes.find((one) => one.scopeId === placement.scopeId);
      const plan: HealthCloudPlan = {
        signedIn: true,
        scopeName: scope?.name ?? null,
        canWrite: placement.canWrite,
        accountTypeName: scope?.accountTypeName ?? null,
        maxMonitors: scope?.maxMonitors ?? null,
        active: scope?.active ?? 0,
        minIntervalSec: scope?.minIntervalSec ?? 300,
        blocked: null,
        action: null,
        telegramLinked: link?.linked === true,
      };
      const alreadyOnline = targetOrProject.runMode === 'cloud';
      // A draft's address is checked in the dialog as it is typed.
      const urlProblem =
        targetOrProject.url === undefined
          ? null
          : cloudUrlProblem(targetOrProject.url, targetOrProject.allowInsecure === true);
      if (!placement.canWrite) {
        plan.blocked = "A Viewer can not change the team's monitors.";
      } else if (urlProblem && !alreadyOnline) {
        plan.blocked = urlProblem;
      } else if (!alreadyOnline && plan.maxMonitors !== null && plan.active >= plan.maxMonitors) {
        plan.blocked = `${plan.accountTypeName ?? 'This account type'} allows ${monitors(plan.maxMonitors)}, and ${plan.scopeName ?? 'this scope'} has ${plan.active}. Pause one, or choose a type with more.`;
        plan.action = 'upgrade';
      }
      return plan;
    },

    /**
     * Turns a monitor online. The key goes to the server only with the person's consent; a
     * monitor a teammate turned online already is joined rather than made twice.
     */
    async enable(targetId: string, input: HealthCloudEnableInput): Promise<void> {
      if (!input.consent) {
        throw new Error(
          "Runova Cloud needs the monitor's address and access key to check it. Agree to send them first.",
        );
      }
      if (!(await deps.signedIn())) {
        throw new Error('Sign in to your Runova account to check this monitor from Runova Cloud.');
      }
      const target = await findTarget(targetId);
      const urlProblem = cloudUrlProblem(target.url, target.allowInsecure);
      if (urlProblem) throw new Error(urlProblem);
      const placement = await deps.placement(target.projectId);
      if (!placement) {
        throw new Error(
          'This project is not synced to your account yet. Sync it first, then turn the monitor online.',
        );
      }
      if (!placement.canWrite) throw new Error("A Viewer can not change the team's monitors.");
      const secret = await deps.openSecret(target);
      if (secret === null) {
        throw new Error("Open the Servers vault first: the monitor's key is sealed in it.");
      }
      const names = await deps.names(target);
      let monitor: CloudMonitorDto;
      try {
        monitor = await deps.api<CloudMonitorDto>('POST', '/cloud-monitors', {
          scopeId: placement.scopeId,
          itemId: target.id,
          name: target.name,
          projectName: names.projectName,
          environmentName: names.environmentName,
          url: target.url,
          intervalSec: input.intervalSec,
          timeoutSec: Math.min(target.timeoutSec, input.intervalSec - 1),
          authMode: target.authMode,
          secret: cloudSecretFor(target.authMode, target.basicUser, secret),
          allowInsecure: target.allowInsecure,
          paused: target.paused,
          notifyInApp: input.notifyInApp,
          notifyTelegram: input.notifyTelegram,
        });
      } catch (error) {
        if (statusOf(error) !== 409 || !/online already/.test(messageOf(error))) throw error;
        // A teammate (or this computer before a reinstall) turned it online already.
        await refresh();
        const existing = monitorOf(target);
        if (!existing) throw error;
        monitor = existing;
      }
      byId.set(monitor.id, monitor);
      signedIn = true;
      await deps.setRunMode(target.id, 'cloud', monitor.id);
      deps.changed([target.id]);
    },

    /** Back to this computer: the server forgets the monitor and its history. */
    async disable(targetId: string): Promise<void> {
      const target = await findTarget(targetId);
      await ensureLoaded();
      const monitor = monitorOf(target);
      if (monitor) {
        try {
          await deps.api('DELETE', `/cloud-monitors/${monitor.id}`, undefined, {
            headers: ifMatch(null),
          });
        } catch (error) {
          if (statusOf(error) !== 404) throw error;
        }
        byId.delete(monitor.id);
        histories.delete(monitor.id);
      }
      await deps.setRunMode(target.id, 'local', null);
      deps.changed([target.id]);
    },

    /** The online settings: alerts in the app and on Telegram, and mute for this account. */
    async settings(targetId: string, patch: HealthCloudSettingsPatch): Promise<void> {
      const target = await findTarget(targetId);
      const { muted, ...rest } = patch;
      if (Object.keys(rest).length > 0) await patchMonitor(target, rest);
      if (muted !== undefined) {
        const monitor = monitorOf(target);
        if (!monitor) throw new Error('This monitor is not on Runova Cloud any more.');
        await deps.api(muted ? 'PUT' : 'DELETE', `/cloud-monitors/${monitor.id}/mutes/me`);
        byId.set(monitor.id, { ...monitor, muted });
        deps.changed([target.id]);
      }
    },

    /** A change made in the monitor dialog, passed on to the server's copy. */
    async push(target: StoredHealthTarget, patch: CloudDefinitionPatch): Promise<void> {
      if (target.runMode !== 'cloud' || Object.keys(patch).length === 0) return;
      await patchMonitor(target, patch);
      histories.delete(monitorOf(target)?.id ?? -1);
    },

    /** A rotated key goes to the server at once, or the nodes would be refused. */
    async rotate(target: StoredHealthTarget, secret: string): Promise<void> {
      if (target.runMode !== 'cloud') return;
      await ensureLoaded();
      const monitor = monitorOf(target);
      if (!monitor) return;
      await deps.api('PUT', `/cloud-monitors/${monitor.id}/secrets/current`, {
        secret: cloudSecretFor(target.authMode, target.basicUser, secret),
      });
    },

    /** A monitor removed from the app is removed from Runova Cloud too. */
    async remove(target: StoredHealthTarget): Promise<void> {
      if (target.runMode !== 'cloud') return;
      await ensureLoaded();
      const monitor = monitorOf(target);
      if (!monitor) return;
      await deps
        .api('DELETE', `/cloud-monitors/${monitor.id}`, undefined, { headers: ifMatch(null) })
        .catch((error: unknown) => {
          if (statusOf(error) !== 404) throw error;
        });
      byId.delete(monitor.id);
      histories.delete(monitor.id);
    },

    /** Reads the server's copy again, after the person asked to check now. */
    async reload(target: StoredHealthTarget): Promise<void> {
      await refresh();
      const monitor = monitorOf(target);
      if (monitor) histories.delete(monitor.id);
    },
  };
}

export type CloudMonitors = ReturnType<typeof createCloudMonitors>;
