import {
  buildLimitChips,
  getUsageProvider,
  type LimitChip,
  type ProviderUsage,
} from '@runova/core';
import type { ManageProviderUsage, ManageSystemStats, ManageUsage } from '@runova/protocol';
import type { SystemStatsSample } from '../../../shared/apiTypes';
import type { ManageMethods } from './session';

/** What the status methods need from the rest of the app. */
export interface ManageStatusDeps {
  system(): Promise<SystemStatsSample>;
  usage(): Promise<ProviderUsage[]>;
  /** The same switches the desktop's status bar follows. */
  shownLimits(): Promise<Partial<Record<string, boolean>> | undefined>;
  now(): number;
}

const HISTORY_DAYS = 30;

function limitOf(chip: LimitChip, now: number): ManageUsage['limits'][number] {
  return {
    providerId: chip.providerId,
    name: chip.name,
    plan: chip.plan,
    state: chip.state,
    problem: chip.problem,
    windows: chip.windows.map((window) => ({
      label: window.label,
      percent: window.percent,
      resetInMs: window.resetAt ? Date.parse(window.resetAt) - now : null,
    })),
  };
}

function providerOf(usage: ProviderUsage): ManageProviderUsage {
  return {
    providerId: usage.providerId,
    name: getUsageProvider(usage.providerId)?.name ?? usage.providerId,
    status: usage.status,
    error: usage.error ?? null,
    todayUsd: usage.today.costUsd,
    weekUsd: usage.last7d.costUsd,
    monthUsd: usage.last30d.costUsd,
    series: (usage.costSeries ?? usage.series ?? []).slice(-HISTORY_DAYS),
  };
}

export function statusMethods(deps: ManageStatusDeps): ManageMethods['calls'] {
  return {
    'status.system': async (): Promise<ManageSystemStats> => {
      const sample = await deps.system();
      return {
        cpuModel: sample.cpuModel,
        cpuCoreCount: sample.cpuCoreCount,
        cpuPercent: sample.cpuPercent,
        memPercent: sample.memPercent,
        memUsedBytes: sample.memUsedBytes,
        memTotalBytes: sample.memTotalBytes,
        netRxBytesPerSec: sample.netRxBytesPerSec,
        netTxBytesPerSec: sample.netTxBytesPerSec,
      };
    },
    'status.usage': async (): Promise<ManageUsage> => {
      const [usage, shown] = await Promise.all([deps.usage(), deps.shownLimits()]);
      const now = deps.now();
      return {
        limits: buildLimitChips(usage, shown).map((chip) => limitOf(chip, now)),
        providers: usage.map(providerOf),
      };
    },
  };
}
