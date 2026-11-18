import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../../shared/deploy/trafficValidation';
import { IPC } from '../../shared/ipcChannels';
import type { DeployTraffic } from '../deploy/traffic/service';
import { registerDeployTrafficHandlers } from './deployTraffic';

/**
 * The Traffic section's channels (E109, E110): main window only, every argument checked for its
 * shape and size before the service sees it, the step-up proof passed along where a call needs one,
 * and live views owned by the window that opened them.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const SUBSCRIPTION = '6f1c8a3e-2b4d-4e5f-9a1b-0c2d3e4f5a6b';
const ZONE = '023e105f4ecef8ad9ca31a8372d0c353';
const NOW = 1_780_000_000_000;

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const traffic = {
    status: vi.fn(async () => ({})),
    report: vi.fn(async () => ({})),
    dimension: vi.fn(async () => ({})),
    saveSettings: vi.fn(async () => ({ problems: [], status: null })),
    deleteData: vi.fn(async () => ({})),
    attacks: vi.fn(async () => ({})),
    saveAttackSettings: vi.fn(async () => ({ problems: [], status: null })),
    saveAutoBlock: vi.fn(async () => ({ problems: [], status: null })),
    blocked: vi.fn(async () => []),
    block: vi.fn(async () => ({ problems: [] })),
    unblock: vi.fn(async () => undefined),
  };
  const live = { watch: vi.fn(() => SUBSCRIPTION), unwatch: vi.fn(() => true) };
  const geolocation = {
    status: vi.fn(async () => ({ connected: true, sites: [] })),
    turnOn: vi.fn(async () => ({ connected: true, sites: [] })),
  };
  const owner = { id: 7, send: vi.fn() };
  registerDeployTrafficHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    traffic: traffic as unknown as DeployTraffic,
    live,
    geolocation,
    guard: () => trusted,
    owner: () => owner,
  });
  const call = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { handlers, traffic, live, geolocation, owner, call };
}

const REPORT = {
  serverId: 'srv-1',
  siteId: 'blog',
  fromUnixMs: NOW - 86_400_000,
  toUnixMs: NOW,
  granularity: 'hour',
  compare: true,
};

const SETTINGS = {
  enabled: true,
  countries: true,
  excludedSites: ['shop'],
  hourlyRetentionDays: 90,
  dailyRetentionDays: 730,
  timeZone: 'Europe/Berlin',
  readExistingLogs: true,
};

describe('registerDeployTrafficHandlers', () => {
  it('handles every invoke channel of the group, and none of its events', () => {
    const { handlers } = harness();

    const { onLive, ...invokes } = IPC.deployTraffic;
    expect([...handlers.keys()].sort()).toEqual(Object.values(invokes).sort());
    expect(handlers.has(onLive)).toBe(false);
  });

  it('answers only the main window', async () => {
    const { call, traffic, live } = harness(false);

    await expect(call(IPC.deployTraffic.status, 'srv-1')).rejects.toThrow(/main window/);
    await expect(
      call(IPC.deployTraffic.watchLive, { serverId: 'srv-1', siteId: null }),
    ).rejects.toThrow(/main window/);
    expect(traffic.status).not.toHaveBeenCalled();
    expect(live.watch).not.toHaveBeenCalled();
  });

  it('passes a report request with every field checked', async () => {
    const { call, traffic } = harness();

    await call(IPC.deployTraffic.report, REPORT);
    expect(traffic.report).toHaveBeenCalledWith(REPORT);

    await call(IPC.deployTraffic.report, { ...REPORT, siteId: null });
    const { siteId: _, ...allSites } = REPORT;
    expect(traffic.report).toHaveBeenLastCalledWith(allSites);

    for (const bad of [
      { ...REPORT, serverId: '../x' },
      { ...REPORT, siteId: 'Not A Site' },
      { ...REPORT, granularity: 'second' },
      { ...REPORT, fromUnixMs: REPORT.toUnixMs },
      { ...REPORT, fromUnixMs: -5 },
      { ...REPORT, fromUnixMs: 1.5 },
      { ...REPORT, fromUnixMs: NOW - 4 * 366 * 86_400_000 },
      { ...REPORT, compare: 'yes' },
      'nope',
    ]) {
      await expect(call(IPC.deployTraffic.report, bad)).rejects.toThrow();
    }
    expect(traffic.report).toHaveBeenCalledTimes(2);
  });

  it('checks a dimension page, its size and its search', async () => {
    const { call, traffic } = harness();
    const page = {
      serverId: 'srv-1',
      fromUnixMs: NOW - 86_400_000,
      toUnixMs: NOW,
      dimension: 'referrer',
      offset: 100,
      limit: 100,
      search: 'google',
    };

    await call(IPC.deployTraffic.dimension, page);
    expect(traffic.dimension).toHaveBeenCalledWith(page);
    await call(IPC.deployTraffic.dimension, { ...page, search: '' });
    const { search: _, ...noSearch } = page;
    expect(traffic.dimension).toHaveBeenLastCalledWith(noSearch);

    await expect(call(IPC.deployTraffic.dimension, { ...page, limit: 5000 })).rejects.toThrow();
    await expect(call(IPC.deployTraffic.dimension, { ...page, dimension: 'ip' })).rejects.toThrow();
    await expect(
      call(IPC.deployTraffic.dimension, { ...page, search: 'x'.repeat(201) }),
    ).rejects.toThrow();
  });

  it('checks the settings shape and leaves the limits to the service', async () => {
    const { call, traffic } = harness();

    await call(IPC.deployTraffic.saveSettings, { serverId: 'srv-1', settings: SETTINGS });
    expect(traffic.saveSettings).toHaveBeenCalledWith({ serverId: 'srv-1', settings: SETTINGS });

    await call(IPC.deployTraffic.saveSettings, {
      serverId: 'srv-1',
      settings: { ...SETTINGS, readExistingLogs: undefined, hourlyRetentionDays: 3 },
    });
    expect(traffic.saveSettings).toHaveBeenLastCalledWith({
      serverId: 'srv-1',
      settings: { ...SETTINGS, readExistingLogs: false, hourlyRetentionDays: 3 },
    });

    for (const settings of [
      { ...SETTINGS, enabled: 'on' },
      { ...SETTINGS, excludedSites: 'blog' },
      { ...SETTINGS, excludedSites: ['Bad Site'] },
      { ...SETTINGS, excludedSites: Array.from({ length: 501 }, (_, i) => `s${i}`) },
      { ...SETTINGS, timeZone: 'x'.repeat(65) },
      { ...SETTINGS, dailyRetentionDays: '730' },
    ]) {
      await expect(
        call(IPC.deployTraffic.saveSettings, { serverId: 'srv-1', settings }),
      ).rejects.toThrow();
    }
  });

  it('passes the step-up proof with a deletion, for one site or all', async () => {
    const { call, traffic } = harness();

    await call(IPC.deployTraffic.deleteData, { serverId: 'srv-1', siteId: null, password: 'pw' });
    expect(traffic.deleteData).toHaveBeenCalledWith({
      serverId: 'srv-1',
      siteId: null,
      password: 'pw',
    });
    await call(IPC.deployTraffic.deleteData, { serverId: 'srv-1', siteId: 'blog' });
    expect(traffic.deleteData).toHaveBeenLastCalledWith({ serverId: 'srv-1', siteId: 'blog' });
    await expect(
      call(IPC.deployTraffic.deleteData, { serverId: 'srv-1', siteId: 'Bad Site' }),
    ).rejects.toThrow();
  });

  it('checks attack queries and detection settings', async () => {
    const { call, traffic } = harness();

    await call(IPC.deployTraffic.attacks, { serverId: 'srv-1', limit: 50 });
    expect(traffic.attacks).toHaveBeenCalledWith({ serverId: 'srv-1', limit: 50 });
    await call(IPC.deployTraffic.attacks, {
      serverId: 'srv-1',
      siteId: 'blog',
      fromUnixMs: NOW - 1000,
      toUnixMs: NOW,
      limit: 10,
    });
    await expect(
      call(IPC.deployTraffic.attacks, { serverId: 'srv-1', limit: 0 }),
    ).rejects.toThrow();

    const attack = {
      enabled: true,
      thresholds: { ...DEFAULT_THRESHOLDS },
      allowlist: ['10.0.0.0/8'],
      eventRetentionDays: 30,
    };
    await call(IPC.deployTraffic.saveAttackSettings, { serverId: 'srv-1', settings: attack });
    expect(traffic.saveAttackSettings).toHaveBeenCalledWith({
      serverId: 'srv-1',
      settings: attack,
    });
    for (const settings of [
      { ...attack, thresholds: { ...DEFAULT_THRESHOLDS, scanProbes: '20' } },
      { ...attack, thresholds: { scanProbes: 20 } },
      { ...attack, allowlist: [42] },
      { ...attack, allowlist: Array.from({ length: 1001 }, () => '10.0.0.1') },
    ]) {
      await expect(
        call(IPC.deployTraffic.saveAttackSettings, { serverId: 'srv-1', settings }),
      ).rejects.toThrow();
    }
  });

  it('passes auto-block with its proof and refuses kinds it does not know', async () => {
    const { call, traffic } = harness();
    const settings = { enabled: true, kinds: ['scan', 'flood'], minutes: 0, maxBlocked: 100 };

    await call(IPC.deployTraffic.saveAutoBlock, {
      serverId: 'srv-1',
      settings,
      totpCode: '123456',
    });
    expect(traffic.saveAutoBlock).toHaveBeenCalledWith({
      serverId: 'srv-1',
      settings,
      totpCode: '123456',
    });
    await expect(
      call(IPC.deployTraffic.saveAutoBlock, {
        serverId: 'srv-1',
        settings: { ...settings, kinds: ['everything'] },
      }),
    ).rejects.toThrow();
  });

  it('checks blocking and unblocking', async () => {
    const { call, traffic } = harness();

    await call(IPC.deployTraffic.block, {
      serverId: 'srv-1',
      network: '198.51.100.23',
      reason: 'Scan on blog',
      minutes: 60,
      siteId: 'blog',
    });
    expect(traffic.block).toHaveBeenCalledWith({
      serverId: 'srv-1',
      network: '198.51.100.23',
      reason: 'Scan on blog',
      minutes: 60,
      siteId: 'blog',
    });
    await expect(
      call(IPC.deployTraffic.block, { serverId: 'srv-1', network: 'x'.repeat(65) }),
    ).rejects.toThrow();
    await expect(
      call(IPC.deployTraffic.block, { serverId: 'srv-1', network: '1.2.3.4', minutes: -1 }),
    ).rejects.toThrow();

    await call(IPC.deployTraffic.unblock, { serverId: 'srv-1', blockId: 4 });
    expect(traffic.unblock).toHaveBeenCalledWith({ serverId: 'srv-1', blockId: 4 });
    await expect(
      call(IPC.deployTraffic.unblock, { serverId: 'srv-1', blockId: 0 }),
    ).rejects.toThrow();
    await call(IPC.deployTraffic.blocked, 'srv-1');
    expect(traffic.blocked).toHaveBeenCalledWith('srv-1');
  });

  it('opens and ends live views for the window that asked', async () => {
    const { call, live, owner } = harness();

    expect(await call(IPC.deployTraffic.watchLive, { serverId: 'srv-1', siteId: 'blog' })).toBe(
      SUBSCRIPTION,
    );
    expect(live.watch).toHaveBeenCalledWith(owner, { serverId: 'srv-1', siteId: 'blog' });
    await call(IPC.deployTraffic.watchLive, { serverId: 'srv-1' });
    expect(live.watch).toHaveBeenLastCalledWith(owner, { serverId: 'srv-1', siteId: null });

    await call(IPC.deployTraffic.unwatchLive, SUBSCRIPTION);
    expect(live.unwatch).toHaveBeenCalledWith(owner, SUBSCRIPTION);
    await expect(call(IPC.deployTraffic.unwatchLive, 'not-an-id')).rejects.toThrow(
      /not a subscription/,
    );
  });

  it('reads and turns on Cloudflare geolocation for a zone', async () => {
    const { call, geolocation } = harness();

    await call(IPC.deployTraffic.geolocation, 'srv-1');
    expect(geolocation.status).toHaveBeenCalledWith('srv-1');
    await call(IPC.deployTraffic.turnOnGeolocation, { serverId: 'srv-1', zoneId: ZONE });
    expect(geolocation.turnOn).toHaveBeenCalledWith('srv-1', ZONE);
    await expect(
      call(IPC.deployTraffic.turnOnGeolocation, { serverId: 'srv-1', zoneId: 'example.com' }),
    ).rejects.toThrow(/not a Cloudflare zone/);
  });
});
