import { describe, expect, it } from 'vitest';
import {
  applyLive,
  type CloudMonitor,
  dailyBars,
  groupMonitors,
  intervalChoices,
  latencyLine,
  latestByRegion,
  type MonitorStatus,
  overall,
  type ScopeUsage,
  verdictLabel,
} from '../src/lib/account/monitoring';

const NOW = Date.parse('2026-11-07T12:00:00Z');

function status(overrides: Partial<MonitorStatus> = {}): MonitorStatus {
  return {
    verdict: 'up',
    state: 'pass',
    lastCheckedAt: '2026-11-07T11:59:00Z',
    latencyMs: 120,
    httpStatus: 200,
    problem: null,
    region: 'eu-central',
    confirming: false,
    openIncident: null,
    uptime24h: 1,
    ...overrides,
  };
}

function monitor(overrides: Partial<CloudMonitor> = {}): CloudMonitor {
  return {
    id: 1,
    scopeId: 10,
    itemId: 't-api',
    name: 'API',
    projectName: 'Storefront',
    environmentName: 'Production',
    url: 'https://api.example.com/health',
    intervalSec: 300,
    timeoutSec: 10,
    authMode: 'bearer',
    hasSecret: true,
    secretChangedAt: null,
    allowInsecure: false,
    paused: false,
    suspendedReason: null,
    notifyInApp: true,
    notifyTelegram: false,
    muted: false,
    canWrite: true,
    status: status(),
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    version: '7',
    ...overrides,
  };
}

function scope(overrides: Partial<ScopeUsage> = {}): ScopeUsage {
  return {
    scopeId: 10,
    kind: 'personal',
    name: 'Personal',
    canWrite: true,
    accountTypeKey: 'go',
    accountTypeName: 'Go',
    maxMonitors: 10,
    minIntervalSec: 300,
    historyDays: 30,
    active: 1,
    paused: 0,
    ...overrides,
  };
}

describe('groupMonitors', () => {
  it('puts each scope under its own name, then projects and environments in order', () => {
    const scopes = [
      scope(),
      scope({ scopeId: 20, kind: 'team', name: 'Platform', canWrite: false }),
      scope({ scopeId: 30, kind: 'team', name: 'Growth' }),
    ];
    const monitors = [
      monitor({ id: 1, projectName: 'Storefront', environmentName: 'Staging', name: 'API' }),
      monitor({ id: 2, projectName: 'Admin', environmentName: null, name: 'Web' }),
      monitor({ id: 3, projectName: 'Storefront', environmentName: 'Production', name: 'API' }),
      monitor({ id: 4, scopeId: 20, projectName: 'Billing', name: 'Worker', canWrite: false }),
    ];

    const groups = groupMonitors(monitors, scopes);

    // A scope with no monitors is left out.
    expect(groups.map((g) => g.scope.name)).toEqual(['Personal', 'Platform']);
    expect(groups[0].projects.map((p) => p.name)).toEqual(['Admin', 'Storefront']);
    expect(groups[0].projects[1].environments.map((e) => e.name)).toEqual([
      'Production',
      'Staging',
    ]);
    expect(groups[1].projects[0].environments[0].monitors.map((m) => m.id)).toEqual([4]);
  });

  it('keeps a monitor whose scope the usage does not list, under a plain name', () => {
    const groups = groupMonitors([monitor({ scopeId: 99 })], [scope()]);
    expect(groups[0].scope).toMatchObject({ scopeId: 99, name: 'Shared with you' });
  });
});

describe('overall', () => {
  it('says how things are in words, the worst first', () => {
    expect(overall([])).toEqual({ text: 'No online monitors yet', tone: 'neutral' });
    expect(overall([monitor(), monitor({ id: 2 })])).toEqual({
      text: 'All 2 monitors up',
      tone: 'success',
    });
    expect(overall([monitor()])).toEqual({ text: 'The monitor is up', tone: 'success' });
    expect(
      overall([
        monitor({ status: status({ verdict: 'down' }) }),
        monitor({ id: 2, status: status({ verdict: 'down' }) }),
        monitor({ id: 3, status: status({ verdict: 'degraded' }) }),
        monitor({ id: 4, paused: true, status: status({ verdict: 'paused' }) }),
      ]),
    ).toEqual({ text: '2 down, 1 degraded, 1 paused', tone: 'danger' });
    expect(overall([monitor({ status: status({ verdict: 'degraded' }) })])).toEqual({
      text: '1 degraded',
      tone: 'warning',
    });
    expect(overall([monitor({ status: status({ verdict: 'unknown', state: null }) })])).toEqual({
      text: '1 waiting for its first check',
      tone: 'neutral',
    });
  });
});

describe('applyLive', () => {
  it('moves the monitor the update names and leaves the others alone', () => {
    const list = [monitor(), monitor({ id: 2 })];
    const next = applyLive(list, {
      id: 2,
      scopeId: 10,
      itemId: 't-api',
      paused: false,
      status: status({ verdict: 'down', state: 'fail' }),
    });

    expect(next[0]).toBe(list[0]);
    expect(next[1].status.verdict).toBe('down');
    expect(list[1].status.verdict).toBe('up');
  });

  it('ignores an update for a monitor the page does not show', () => {
    const list = [monitor()];
    expect(
      applyLive(list, { id: 9, scopeId: 10, itemId: 'x', paused: false, status: status() }),
    ).toBe(list);
  });
});

describe('dailyBars', () => {
  it('makes one bar a day, oldest first, from the hours', () => {
    const hours = [
      {
        hour: '2026-11-07T09:00:00Z',
        checks: 12,
        failures: 0,
        warnings: 0,
        avgLatencyMs: 100,
        maxLatencyMs: 200,
      },
      {
        hour: '2026-11-07T10:00:00Z',
        checks: 12,
        failures: 3,
        warnings: 0,
        avgLatencyMs: 100,
        maxLatencyMs: 200,
      },
      {
        hour: '2026-11-05T10:00:00Z',
        checks: 12,
        failures: 0,
        warnings: 2,
        avgLatencyMs: 100,
        maxLatencyMs: 200,
      },
    ];

    const bars = dailyBars(hours, 3, NOW);

    expect(bars.map((b) => b.tone)).toEqual(['warning', 'none', 'danger']);
    expect(bars[2]).toMatchObject({ checks: 24, failures: 3 });
    expect(bars[2].label).toMatch(/Nov 7: 87.5% up, 3 failed checks/);
    expect(bars[1].label).toMatch(/Nov 6: no checks/);
  });
});

describe('latencyLine and latestByRegion', () => {
  it('reads the average latency of each hour, leaving gaps where there was none', () => {
    const line = latencyLine([
      {
        hour: '2026-11-07T10:00:00Z',
        checks: 12,
        failures: 0,
        warnings: 0,
        avgLatencyMs: 140,
        maxLatencyMs: 300,
      },
      {
        hour: '2026-11-07T11:00:00Z',
        checks: 12,
        failures: 12,
        warnings: 0,
        avgLatencyMs: null,
        maxLatencyMs: null,
      },
    ]);
    expect(line).toEqual([
      { at: Date.parse('2026-11-07T10:00:00Z'), value: 140 },
      { at: Date.parse('2026-11-07T11:00:00Z'), value: null },
    ]);
  });

  it('keeps the newest sample of each region', () => {
    const latest = latestByRegion([
      {
        at: '2026-11-07T11:00:00Z',
        state: 'pass',
        latencyMs: 90,
        httpStatus: 200,
        region: 'eu-central',
        problem: null,
      },
      {
        at: '2026-11-07T11:01:00Z',
        state: 'fail',
        latencyMs: null,
        httpStatus: 503,
        region: 'us-east',
        problem: 'Down',
      },
      {
        at: '2026-11-07T11:05:00Z',
        state: 'pass',
        latencyMs: 80,
        httpStatus: 200,
        region: 'eu-central',
        problem: null,
      },
    ]);
    expect(latest.map((s) => [s.region, s.latencyMs])).toEqual([
      ['eu-central', 80],
      ['us-east', null],
    ]);
  });
});

describe('labels', () => {
  it('names each verdict and offers the intervals the type allows', () => {
    expect(verdictLabel('down')).toBe('Down');
    expect(verdictLabel('unknown')).toBe('Waiting');
    expect(intervalChoices(300).map((c) => c.label)).toEqual([
      '5 min',
      '15 min',
      '1 hour',
      '6 hours',
      '1 day',
    ]);
    expect(intervalChoices(30)[0]).toEqual({ seconds: 30, label: '30 sec' });
  });
});
