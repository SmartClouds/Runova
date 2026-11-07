import {
  type HealthReport,
  type HealthState,
  healthDays,
  healthHoursFromSamples,
  healthLatencyHours,
  healthUptimeSince,
} from '@runova/core';
import type {
  HealthCloudInfo,
  HealthTargetDetail,
  HealthTargetSummary,
} from '../../shared/healthTypes';
import type { HealthResultRecord, StoredHealthTarget } from './store';

const CHART_DAYS = 30;
const CHART_HOURS = 24;

/**
 * Turns a stored target and its results into what the Health page shows. The sealed key never
 * leaves here: the page only learns whether there is one.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const STRIP_SAMPLES = 50;
const MAX_HEADLINE = 200;

export interface HealthSummaryContext {
  now: number;
  /** The key is sealed under the Servers passkey, which is locked right now. */
  locked: boolean;
  /** For a monitor on Runova Cloud (E56): what the server says of it. */
  cloud?: { info: HealthCloudInfo; paused: boolean } | null;
}

const SIGNED_OUT = 'Sign in to see what Runova Cloud found. This computer does not check it.';

/** What a cloud monitor's card says before any result: signed out, or paused by the account type. */
function cloudHeadline(cloud: HealthCloudInfo | null): string | null {
  if (!cloud) return null;
  if (!cloud.signedIn) return SIGNED_OUT;
  if (cloud.suspendedReason === 'over-limit') {
    return 'Paused by Runova: the account type allows fewer online monitors. Resume it once there is room.';
  }
  return null;
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0].trim();
  return line.length > MAX_HEADLINE ? `${line.slice(0, MAX_HEADLINE - 3)}...` : line;
}

/** A short line for a report: the probe problem, or the first failing service's error. */
export function healthHeadline(report: HealthReport | null): string | null {
  if (!report) return null;
  if (report.problem) return firstLine(report.problem);
  const failing =
    report.services.find((service) => service.status === 'fail') ??
    report.services.find((service) => service.status === 'warn');
  if (failing?.error) return firstLine(`${failing.key}: ${failing.error.message}`);
  if (report.output) return firstLine(report.output);
  return null;
}

/** The hourly roll-up; a record made in memory without one gets it from its samples. */
function hoursOf(result: HealthResultRecord | undefined) {
  if (!result) return [];
  return result.hours?.length ? result.hours : healthHoursFromSamples(result.samples);
}

function stateOf(
  target: StoredHealthTarget,
  result: HealthResultRecord | undefined,
  context: HealthSummaryContext,
): HealthState {
  if (context.cloud) {
    // The server checks it, so the vault being locked here does not stop anything.
    if (context.cloud.paused) return 'paused';
    return result?.report?.state ?? 'pending';
  }
  if (target.paused) return 'paused';
  if (context.locked) return 'locked';
  return result?.report?.state ?? 'pending';
}

export function toHealthSummary(
  target: StoredHealthTarget,
  result: HealthResultRecord | undefined,
  context: HealthSummaryContext,
): HealthTargetSummary {
  const { secretEnvelope, runMode, cloudMonitorId: _cloudMonitorId, ...setup } = target;
  const samples = result?.samples ?? [];
  const hours = hoursOf(result);
  const report = result?.report ?? null;
  const cloud = context.cloud?.info ?? null;
  return {
    ...setup,
    paused: context.cloud ? context.cloud.paused : target.paused,
    runMode: runMode === 'cloud' ? 'cloud' : 'local',
    cloud,
    hasSecret: secretEnvelope !== null,
    state: stateOf(target, result, context),
    lastCheckedAt: result?.lastCheckedAt ?? null,
    nextCheckAt: result?.nextCheckAt ?? null,
    latencyMs: report?.latencyMs ?? null,
    version: target.showVersion === false ? null : (report?.version ?? null),
    uptime24h: healthUptimeSince(hours, context.now - DAY_MS),
    daily: healthDays(hours, { days: CHART_DAYS, now: context.now }),
    samples: samples.slice(-STRIP_SAMPLES),
    servicesTotal: report?.services.length ?? 0,
    servicesFailing: report?.services.filter((service) => service.status === 'fail').length ?? 0,
    headline: cloudHeadline(cloud) ?? healthHeadline(report),
    openIncident: result?.incidents.find((incident) => incident.resolvedAt === null) ?? null,
  };
}

export function toHealthDetail(
  target: StoredHealthTarget,
  result: HealthResultRecord | undefined,
  context: HealthSummaryContext,
): HealthTargetDetail {
  return {
    target: toHealthSummary(target, result, context),
    report: result?.report ?? null,
    incidents: result?.incidents ?? [],
    samples: result?.samples ?? [],
    latency: healthLatencyHours(hoursOf(result), { hoursBack: CHART_HOURS, now: context.now }),
  };
}
