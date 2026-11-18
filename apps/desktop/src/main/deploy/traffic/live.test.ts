import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCore } from '../../../shared/deploy/testing/fakeCore';
import type { DeployTrafficLiveEvent } from '../../../shared/deployTrafficTypes';
import { IPC } from '../../../shared/ipcChannels';
import { CoreLinks } from '../live/coreLinks';
import { fakeLiveHubs } from '../testing/fakeLiveHub';
import { TrafficLiveFeed, TrafficLiveSubscriptions } from './live';

/**
 * Live visitors (E109): what the core says every few seconds goes to the window that asked and to
 * no other, a new connection carries on, an older core ends it with the way out, and a window that
 * goes away takes its streams with it.
 */

let links: CoreLinks | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  links?.closeAll();
  links = null;
  vi.useRealTimers();
});

function setup() {
  const core = new FakeCore(() => Date.now());
  const hubs = fakeLiveHubs(core);
  links = new CoreLinks({ open: () => hubs.open() });
  let n = 0;
  const live = new TrafficLiveSubscriptions({ links, newId: () => `live-${++n}` });
  const events: DeployTrafficLiveEvent[] = [];
  const owner = {
    id: 1,
    send: vi.fn((channel: string, payload: unknown) => {
      expect(channel).toBe(IPC.deployTraffic.onLive);
      events.push(payload as DeployTrafficLiveEvent);
    }),
  };
  return { core, hubs, live, events, owner };
}

describe('TrafficLiveSubscriptions', () => {
  it('passes each reading on to the window that asked', async () => {
    const { hubs, live, events, owner } = setup();

    const id = live.watch(owner, { serverId: 'srv-1', siteId: 'blog' });
    await vi.advanceTimersByTimeAsync(50);
    expect(events).toEqual([
      expect.objectContaining({
        subscriptionId: id,
        serverId: 'srv-1',
        siteId: 'blog',
        live: expect.objectContaining({ visitorsNow: 4 }),
      }),
    ]);
    expect(hubs.latest()?.requested.at(-1)).toEqual({
      kind: 'trafficLive',
      args: [{ siteId: 'blog' }],
    });

    hubs.latest()?.deliverTrafficLive({
      atUnixMs: 1,
      visitorsNow: 9,
      requestsLastMinute: 80,
      pagesNow: [],
    });
    expect(events.at(-1)?.live?.visitorsNow).toBe(9);
    expect(live.unwatch(owner, id)).toBe(true);
    expect(live.unwatch(owner, id)).toBe(false);
    expect(hubs.latest()?.openStreams('trafficLive')).toBe(0);
  });

  it('asks for every site when no site is picked', async () => {
    const { hubs, live, owner } = setup();

    live.watch(owner, { serverId: 'srv-1', siteId: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(hubs.latest()?.requested.at(-1)?.args).toEqual([{}]);
  });

  it('carries on over a new connection', async () => {
    const { core, hubs, live, events, owner } = setup();
    live.watch(owner, { serverId: 'srv-1', siteId: null });
    await vi.advanceTimersByTimeAsync(50);

    core.dropAll();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hubs.opens()).toBeGreaterThan(1);
    expect(events.length).toBeGreaterThan(1);
    expect(events.every((event) => event.ended === undefined)).toBe(true);
  });

  it('ends with the way out on a core from before this feature', async () => {
    const { core, live, events, owner } = setup();
    core.trafficMissing = true;

    live.watch(owner, { serverId: 'srv-1', siteId: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(events).toEqual([
      expect.objectContaining({
        ended: { error: expect.stringMatching(/older core without traffic statistics/) },
      }),
    ]);
    expect(live.count()).toBe(0);
  });

  it('holds two per server and ends a window’s streams when it goes', () => {
    const { live, owner } = setup();
    live.watch(owner, { serverId: 'srv-1', siteId: null });
    live.watch({ id: 2, send: vi.fn() }, { serverId: 'srv-1', siteId: 'blog' });
    expect(() => live.watch(owner, { serverId: 'srv-1', siteId: 'shop' })).toThrow(
      /Two live views are already open/,
    );
    live.watch(owner, { serverId: 'srv-2', siteId: null });

    live.dropOwner(1);
    expect(live.count()).toBe(1);
  });

  it('waits out a busy connection and reopens a stream the core ended', () => {
    const next = vi.fn();
    const ended = vi.fn();
    const feed = new TrafficLiveFeed(null, { next, ended });
    expect(feed.failed(new Error('This connection already has 2 trafficLive streams open.'))).toBe(
      5_000,
    );
    expect(feed.ended()).toBe(1_000);
    expect(feed.failed(new Error('There is no such site.'))).toBeNull();
    expect(ended).toHaveBeenCalledWith({ error: 'There is no such site.' });
  });
});
