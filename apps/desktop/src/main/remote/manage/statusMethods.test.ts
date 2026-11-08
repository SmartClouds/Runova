import { emptyUsageTokens, type ProviderUsage } from '@runova/core';
import { describe, expect, it } from 'vitest';
import type { SystemStatsSample } from '../../../shared/apiTypes';
import { type ManageStatusDeps, statusMethods } from './statusMethods';

const context = { phone: { key: 'k', name: 'Runova app', scopes: ['core' as const] } };
const NOW = Date.parse('2026-03-01T12:00:00.000Z');
const period = (costUsd: number | null) => ({ tokens: emptyUsageTokens(), costUsd });

const sample = {
  timestamp: NOW,
  cpuModel: 'Ryzen 9',
  cpuCoreCount: 16,
  cpuPercent: 12.5,
  memPercent: 50,
  memUsedBytes: 8,
  memTotalBytes: 16,
  netRxBytesPerSec: 1000,
  netTxBytesPerSec: 2000,
  disks: [{ id: 'C:' }],
  gpus: [],
  pings: [],
} as unknown as SystemStatsSample;

function usage(change: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    providerId: 'claude-code',
    status: 'ok',
    today: period(1.5),
    last7d: period(10),
    last30d: period(40),
    currency: 'USD',
    updatedAt: '2026-03-01T11:59:00.000Z',
    subscription: {
      mode: 'subscription',
      plan: { label: 'Max' },
      source: 'account',
      windows: [{ key: '5h', label: '5 hours', percent: 25, resetAt: '2026-03-01T15:00:00.000Z' }],
    },
    ...change,
  } as ProviderUsage;
}

function deps(change: Partial<ManageStatusDeps> = {}): ManageStatusDeps {
  return {
    system: async () => sample,
    usage: async () => [usage()],
    shownLimits: async () => undefined,
    now: () => NOW,
    ...change,
  };
}

describe('status methods', () => {
  it('sends the computer numbers the status bar shows and nothing else', async () => {
    const result = (await statusMethods(deps())['status.system'](undefined, context)) as Record<
      string,
      unknown
    >;

    expect(result.cpuPercent).toBe(12.5);
    expect(result.memTotalBytes).toBe(16);
    expect(result.netRxBytesPerSec).toBe(1000);
    expect(result).not.toHaveProperty('disks');
  });

  it('says how long until each limit resets, since a phone clock may disagree', async () => {
    const result = (await statusMethods(deps())['status.usage'](undefined, context)) as {
      limits: { state: string; plan: string; windows: { percent: number; resetInMs: number }[] }[];
    };

    expect(result.limits[0].state).toBe('ok');
    expect(result.limits[0].plan).toBe('Max');
    expect(result.limits[0].windows[0]).toMatchObject({ percent: 25, resetInMs: 3 * 3_600_000 });
  });

  it('marks a provider it could not read', async () => {
    const failing = usage({ status: 'error', subscription: undefined, limitsError: 'Signed out.' });

    const result = (await statusMethods(deps({ usage: async () => [failing] }))['status.usage'](
      undefined,
      context,
    )) as { limits: { state: string; problem: string }[] };

    expect(result.limits[0]).toMatchObject({ state: 'unavailable', problem: 'Signed out.' });
  });

  it('leaves out a provider switched off in the status bar', async () => {
    const result = (await statusMethods(
      deps({ shownLimits: async () => ({ 'claude-code': false }) }),
    )['status.usage'](undefined, context)) as { limits: unknown[] };

    expect(result.limits).toEqual([]);
  });

  it('lists each provider with its costs and at most 30 days of history', async () => {
    const series = Array.from({ length: 90 }, (_, day) => day);

    const result = (await statusMethods(
      deps({ usage: async () => [usage({ costSeries: series })] }),
    )['status.usage'](undefined, context)) as {
      providers: { name: string; todayUsd: number; series: number[] }[];
    };

    expect(result.providers[0].todayUsd).toBe(1.5);
    expect(result.providers[0].series).toHaveLength(30);
    expect(result.providers[0].series.at(-1)).toBe(89);
  });
});
