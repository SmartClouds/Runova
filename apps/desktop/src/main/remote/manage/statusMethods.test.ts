import { emptyUsageTokens, type ProviderUsage } from '@runova/core';
import type { ManageStatusBar } from '@runova/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { SystemStatsSample } from '../../../shared/apiTypes';
import { type ManageStatusBarDeps, type ManageStatusDeps, statusMethods } from './statusMethods';

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

function bar(change: Partial<ManageStatusBarDeps> = {}): ManageStatusBarDeps {
  return {
    agents: () => [
      { cliId: 'claude', status: 'working' },
      { cliId: 'claude', status: 'needs-input' },
      { cliId: 'codex', status: null },
      { cliId: 'codex', status: 'exited' },
      { cliId: undefined, status: 'working' },
    ],
    terminals: async () => 3,
    relays: async () => [
      { status: 'running', current: { phase: 'awaiting-user' } },
      { status: 'running', current: { phase: 'working' } },
      { status: 'paused', current: null },
      { status: 'waiting', current: null },
      { status: 'done', current: null },
    ],
    transfers: () => 2,
    sync: async () =>
      ({
        status: { state: 'signed-in', needsSignIn: false },
        overview: {
          phase: 'idle',
          conflicts: 1,
          scopes: [
            { hasKey: true, unlockedHere: false },
            { hasKey: false, unlockedHere: false },
          ],
        },
      }) as never,
    github: async () => ({ cliAvailable: true, authenticated: true, login: 'sam', owners: [] }),
    docker: async () => [{ state: 'running' }, { state: 'exited' }],
    android: async () => [{ state: 'running' }, { state: 'booting' }, { state: 'stopped' }],
    keepAwake: () => ({ mode: 'agent', blocking: true, busy: ['agents'] }),
    ...change,
  };
}

function deps(change: Partial<ManageStatusDeps> = {}): ManageStatusDeps {
  return {
    system: async () => sample,
    usage: async () => [usage()],
    shownLimits: async () => undefined,
    now: () => NOW,
    bar: bar(),
    ...change,
  };
}

function readBar(input: ManageStatusDeps): Promise<ManageStatusBar> {
  return statusMethods(input)['status.bar'](undefined, context) as Promise<ManageStatusBar>;
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

  it('counts what the status bar would show, leaving out what has ended', async () => {
    const result = await readBar(deps());

    expect(result.agents).toEqual({ working: 1, waiting: 1, finished: 0, idle: 1 });
    expect(result.terminals).toBe(3);
    expect(result.relays).toEqual({ running: 1, paused: 1, scheduled: 1, needsYou: 1 });
    expect(result.transfers).toBe(2);
    expect(result.docker).toEqual({ running: 1, total: 2 });
    expect(result.android).toEqual({ running: 1, booting: 1 });
    expect(result.keepAwake).toEqual({ mode: 'agent', awake: true, busy: ['agents'] });
  });

  it('counts sync keys that this computer still needs', async () => {
    expect((await readBar(deps())).sync).toEqual({
      needsSignIn: false,
      conflicts: 1,
      phase: 'idle',
      keysNeeded: 1,
    });
  });

  it('has no sync line while nobody is signed in', async () => {
    const sync = async () =>
      ({ status: { state: 'signed-out' }, overview: { phase: 'signed-out', scopes: [] } }) as never;

    expect((await readBar(deps({ bar: bar({ sync }) }))).sync).toBeNull();
  });

  it('leaves out what is not installed', async () => {
    const result = await readBar(
      deps({
        bar: bar({
          github: async () => ({
            cliAvailable: false,
            authenticated: false,
            login: null,
            owners: [],
          }),
          docker: async () => null,
          android: async () => null,
        }),
      }),
    );

    expect(result.github).toBeNull();
    expect(result.docker).toBeNull();
    expect(result.android).toBeNull();
  });

  it('leaves out one source that fails instead of failing the bar', async () => {
    const result = await readBar(
      deps({
        bar: bar({
          docker: async () => {
            throw new Error('daemon gone');
          },
        }),
      }),
    );

    expect(result.docker).toBeNull();
    expect(result.terminals).toBe(3);
  });

  it('asks gh rarely while signed in and often while signed out', async () => {
    let now = NOW;
    const signedIn = vi.fn(async () => ({
      cliAvailable: true,
      authenticated: true,
      login: 'sam',
      owners: [],
    }));
    const methods = statusMethods(deps({ now: () => now, bar: bar({ github: signedIn }) }));

    await methods['status.bar'](undefined, context);
    now += 60_000;
    await methods['status.bar'](undefined, context);
    expect(signedIn).toHaveBeenCalledTimes(1);
    now += 5 * 60_000;
    await methods['status.bar'](undefined, context);
    expect(signedIn).toHaveBeenCalledTimes(2);

    const signedOut = vi.fn(async () => ({
      cliAvailable: true,
      authenticated: false,
      login: null,
      owners: [],
    }));
    const quick = statusMethods(deps({ now: () => now, bar: bar({ github: signedOut }) }));
    await quick['status.bar'](undefined, context);
    now += 20_000;
    await quick['status.bar'](undefined, context);
    expect(signedOut).toHaveBeenCalledTimes(2);
  });

  it('remembers the account when a check fails, and says so', async () => {
    let now = NOW;
    const accounts = [
      { cliAvailable: true, authenticated: true, login: 'sam', owners: [] },
      { cliAvailable: true, authenticated: false, login: null, owners: [], checkFailed: true },
    ];
    const github = vi.fn(async () => accounts.shift() ?? accounts[0]);
    const methods = statusMethods(deps({ now: () => now, bar: bar({ github }) }));

    await methods['status.bar'](undefined, context);
    now += 6 * 60_000;
    const result = (await methods['status.bar'](undefined, context)) as ManageStatusBar;

    expect(result.github).toEqual({ login: 'sam', signedIn: true, checkFailed: true });
  });

  it('runs one docker read at a time however many phones ask', async () => {
    let release: (value: { state: string }[]) => void = () => undefined;
    const docker = vi.fn(
      () =>
        new Promise<{ state: string }[]>((resolve) => {
          release = resolve;
        }),
    );
    const methods = statusMethods(deps({ bar: bar({ docker }) }));

    const first = methods['status.bar'](undefined, context);
    const second = methods['status.bar'](undefined, context);
    await vi.waitFor(() => expect(docker).toHaveBeenCalledTimes(1));
    release([{ state: 'running' }]);
    await Promise.all([first, second]);

    expect(docker).toHaveBeenCalledTimes(1);
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
