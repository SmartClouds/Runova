import { describe, expect, it, vi } from 'vitest';
import type { HealthRunMode } from '../../shared/healthTypes';
import {
  type CloudMonitorDto,
  type CloudMonitorsDeps,
  type CloudStatusDto,
  createCloudMonitors,
} from './cloud';
import type { StoredHealthTarget } from './store';

/**
 * Online monitors on this computer (E56): turning one online and back, what the page shows from
 * the server, and the live updates from the hub. The API is a small fake that keeps what it was
 * sent.
 */

const NOW = Date.parse('2026-11-07T09:00:00Z');

function target(overrides: Partial<StoredHealthTarget> = {}): StoredHealthTarget {
  return {
    id: 't-api',
    projectId: 'p1',
    environmentId: null,
    name: 'API',
    serverLabel: null,
    serverLink: null,
    url: 'https://api.example.com/health',
    intervalSec: 60,
    timeoutSec: 10,
    authMode: 'bearer',
    basicUser: null,
    allowInsecure: false,
    autoDiagnose: false,
    createdAt: 1,
    updatedAt: 1,
    paused: false,
    secretEnvelope: { mode: 'safeStorage', ciphertext: 'sealed' },
    secretRotatedAt: null,
    ...overrides,
  };
}

function status(overrides: Partial<CloudStatusDto> = {}): CloudStatusDto {
  return {
    verdict: 'unknown',
    state: null,
    lastCheckedAt: null,
    latencyMs: null,
    httpStatus: null,
    problem: null,
    region: null,
    confirming: false,
    openIncident: null,
    uptime24h: null,
    ...overrides,
  };
}

class ApiError extends Error {
  constructor(readonly problem: { status: number; detail: string }) {
    super(problem.detail);
  }
}

function harness(
  options: {
    signedIn?: boolean;
    canWrite?: boolean;
    max?: number | null;
    active?: number;
    placed?: boolean;
    secret?: string | null;
  } = {},
) {
  let targets = [target()];
  const monitors = new Map<number, CloudMonitorDto>();
  let nextId = 41;
  const calls: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
  }[] = [];
  const api = vi.fn(
    async (
      method: string,
      path: string,
      body?: unknown,
      opts?: { headers?: Record<string, string> },
    ) => {
      calls.push({ method, path, body, headers: opts?.headers });
      if (method === 'GET' && path === '/cloud-monitors') return { items: [...monitors.values()] };
      if (method === 'GET' && path === '/cloud-monitors/usage') {
        return {
          scopes: [
            {
              scopeId: 5,
              name: 'Personal',
              canWrite: true,
              accountTypeName: 'Go',
              maxMonitors: options.max === undefined ? 10 : options.max,
              minIntervalSec: 300,
              active: options.active ?? 0,
            },
          ],
        };
      }
      if (method === 'GET' && path === '/accounts/me/telegram-links/current')
        return { linked: true };
      if (method === 'POST' && path === '/cloud-monitors') {
        const sent = body as {
          itemId: string;
          name: string;
          url: string;
          intervalSec: number;
          notifyInApp: boolean;
          notifyTelegram: boolean;
        };
        if ([...monitors.values()].some((m) => m.itemId === sent.itemId)) {
          throw new ApiError({ status: 409, detail: 'This monitor is online already.' });
        }
        const made: CloudMonitorDto = {
          id: nextId++,
          scopeId: 5,
          itemId: sent.itemId,
          name: sent.name,
          url: sent.url,
          intervalSec: sent.intervalSec,
          paused: false,
          suspendedReason: null,
          notifyInApp: sent.notifyInApp,
          notifyTelegram: sent.notifyTelegram,
          muted: false,
          canWrite: true,
          status: status(),
          version: '1',
        };
        monitors.set(made.id, made);
        return made;
      }
      const one = /^\/cloud-monitors\/(\d+)(\/.*)?$/.exec(path);
      if (one) {
        const monitor = monitors.get(Number(one[1]));
        if (!monitor)
          throw new ApiError({
            status: 404,
            detail: 'There is no such online monitor for this account.',
          });
        const rest = one[2] ?? '';
        if (method === 'DELETE' && rest === '') {
          monitors.delete(monitor.id);
          return undefined;
        }
        if (method === 'PATCH' && rest === '') {
          const updated = { ...monitor, ...(body as object) };
          monitors.set(monitor.id, updated);
          return updated;
        }
        if (rest === '/samples') {
          return {
            items: [
              { at: '2026-11-07T08:58:00Z', state: 'pass', latencyMs: 90 },
              { at: '2026-11-07T08:59:00Z', state: 'fail', latencyMs: null },
            ],
          };
        }
        if (rest === '/hours')
          return {
            items: [
              {
                hour: '2026-10-20T08:00:00Z',
                checks: 60,
                failures: 6,
                avgLatencyMs: 100,
                maxLatencyMs: 400,
              },
            ],
          };
        if (rest.startsWith('/incidents')) {
          return {
            items: [
              {
                id: 3,
                monitorId: monitor.id,
                openedAt: '2026-10-20T08:10:00Z',
                resolvedAt: '2026-10-20T08:20:00Z',
                state: 'unreachable',
                problem: 'Connection refused',
                region: 'eu-central',
                confirmedFrom: 'us-east',
              },
            ],
          };
        }
        return undefined;
      }
      throw new Error(`No route for ${method} ${path}`);
    },
  );
  const changed = vi.fn<(ids: string[]) => void>();
  const setRunMode = vi.fn(
    async (id: string, mode: HealthRunMode, cloudMonitorId: number | null) => {
      targets = targets.map((one) =>
        one.id === id ? { ...one, runMode: mode, cloudMonitorId } : one,
      );
    },
  );
  const deps: CloudMonitorsDeps = {
    api: api as unknown as CloudMonitorsDeps['api'],
    signedIn: async () => options.signedIn ?? true,
    placement: async () =>
      options.placed === false ? null : { scopeId: 5, canWrite: options.canWrite ?? true },
    names: async () => ({ projectName: 'Storefront', environmentName: 'Production' }),
    openSecret: async () => (options.secret === undefined ? 'k3y' : options.secret),
    targets: async () => targets,
    setRunMode,
    changed,
    now: () => NOW,
  };
  return {
    cloud: createCloudMonitors(deps),
    api,
    calls,
    changed,
    setRunMode,
    monitors,
    targets: () => targets,
    setTargets: (next: StoredHealthTarget[]) => {
      targets = next;
    },
  };
}

const ENABLE = { consent: true, intervalSec: 300, notifyInApp: true, notifyTelegram: true };

describe('turning a monitor online', () => {
  it('sends the address, timing, names and the key, then marks the monitor cloud', async () => {
    const h = harness();

    await h.cloud.enable('t-api', ENABLE);

    const post = h.calls.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({
      scopeId: 5,
      itemId: 't-api',
      name: 'API',
      projectName: 'Storefront',
      environmentName: 'Production',
      url: 'https://api.example.com/health',
      intervalSec: 300,
      timeoutSec: 10,
      authMode: 'bearer',
      secret: 'k3y',
      allowInsecure: false,
      paused: false,
      notifyInApp: true,
      notifyTelegram: true,
    });
    expect(h.setRunMode).toHaveBeenCalledWith('t-api', 'cloud', 41);
    expect(h.changed).toHaveBeenCalledWith(['t-api']);
  });

  it('sends HTTP Basic as user:password', async () => {
    const h = harness();
    h.setTargets([target({ authMode: 'basic', basicUser: 'runova' })]);

    await h.cloud.enable('t-api', ENABLE);

    expect(
      (h.calls.find((call) => call.method === 'POST')?.body as { secret?: string } | undefined)
        ?.secret,
    ).toBe('runova:k3y');
  });

  it('sends nothing without consent', async () => {
    const h = harness();

    await expect(h.cloud.enable('t-api', { ...ENABLE, consent: false })).rejects.toThrow(
      /Agree to send them/,
    );
    expect(h.api).not.toHaveBeenCalled();
  });

  it.each([
    [{ signedIn: false }, /Sign in/],
    [{ canWrite: false }, /Viewer/],
    [{ placed: false }, /not synced/],
    [{ secret: null }, /vault/],
  ])('is refused with the reason when %o', async (options, reason) => {
    const h = harness(options);

    await expect(h.cloud.enable('t-api', ENABLE)).rejects.toThrow(reason);
    expect(h.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('is refused for an address on this computer', async () => {
    const h = harness();
    h.setTargets([target({ url: 'http://localhost:3000/health', allowInsecure: true })]);

    await expect(h.cloud.enable('t-api', ENABLE)).rejects.toThrow(/on this computer/);
  });

  it('joins a monitor a teammate turned online already', async () => {
    const h = harness();
    await h.cloud.enable('t-api', ENABLE);
    h.setTargets([target()]);

    await h.cloud.enable('t-api', ENABLE);

    expect(h.setRunMode).toHaveBeenLastCalledWith('t-api', 'cloud', 41);
    expect(h.monitors.size).toBe(1);
  });

  it('turns back to this computer, and the server forgets it', async () => {
    const h = harness();
    await h.cloud.enable('t-api', ENABLE);

    await h.cloud.disable('t-api');

    expect(h.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/cloud-monitors/41' });
    expect(h.setRunMode).toHaveBeenLastCalledWith('t-api', 'local', null);
    expect(h.monitors.size).toBe(0);
  });
});

describe('what the page shows', () => {
  it('says why a monitor can not go online and what to do', async () => {
    expect(await harness({ signedIn: false }).cloud.plan(target())).toMatchObject({
      signedIn: false,
      action: 'sign-in',
    });
    expect(await harness({ max: 1, active: 1 }).cloud.plan(target())).toMatchObject({
      blocked:
        'Go allows 1 online monitor, and Personal has 1. Pause one, or choose a type with more.',
      action: 'upgrade',
    });
    expect(
      (await harness().cloud.plan(target({ url: 'https://10.0.0.4/health' }))).blocked,
    ).toMatch(/private network/);
    expect(await harness().cloud.plan(target())).toMatchObject({
      blocked: null,
      accountTypeName: 'Go',
      maxMonitors: 10,
      minIntervalSec: 300,
      telegramLinked: true,
    });
  });

  it('builds the card and the history from the server', async () => {
    const h = harness();
    await h.cloud.enable('t-api', ENABLE);
    const online = h.targets()[0];
    h.monitors.set(41, {
      ...h.monitors.get(41)!,
      status: status({
        verdict: 'down',
        state: 'unreachable',
        lastCheckedAt: '2026-11-07T08:59:00Z',
        problem: 'Connection refused',
        region: 'eu-central',
        openIncident: {
          id: 9,
          monitorId: 41,
          openedAt: '2026-11-07T08:59:00Z',
          resolvedAt: null,
          state: 'unreachable',
          problem: 'Connection refused',
          region: 'eu-central',
          confirmedFrom: 'us-east',
        },
      }),
    });
    await h.cloud.refresh();

    const result = await h.cloud.result(online, true);

    expect(result?.report).toMatchObject({
      state: 'unreachable',
      problem: 'Connection refused',
      checkedAt: Date.parse('2026-11-07T08:59:00Z'),
    });
    expect(result?.samples.map((one) => one.state)).toEqual(['pass', 'fail']);
    expect(result?.incidents.map((one) => one.id)).toEqual(['cloud:9', 'cloud:3']);
    expect(result?.incidents[0].resolvedAt).toBeNull();
    expect(
      result?.hours.find((one) => one.start === Date.parse('2026-10-20T08:00:00Z')),
    ).toMatchObject({ checks: 60, failures: 6 });
    expect(h.cloud.info(online)).toMatchObject({
      monitorId: 41,
      signedIn: true,
      region: 'eu-central',
      notifyTelegram: true,
    });
  });

  it('moves the card the moment a result arrives from the hub', async () => {
    const h = harness();
    await h.cloud.enable('t-api', ENABLE);
    const online = h.targets()[0];
    await h.cloud.result(online, true);
    h.changed.mockClear();

    await h.cloud.live({
      id: 41,
      scopeId: 5,
      itemId: 't-api',
      paused: false,
      status: status({
        verdict: 'up',
        state: 'pass',
        lastCheckedAt: '2026-11-07T09:00:00Z',
        latencyMs: 77,
        region: 'us-east',
      }),
    });

    expect(h.changed).toHaveBeenCalledWith(['t-api']);
    const result = await h.cloud.result(online, false);
    expect(result?.report).toMatchObject({ state: 'pass', latencyMs: 77 });
    expect(result?.samples.at(-1)).toEqual({ at: NOW, state: 'pass', latencyMs: 77 });
    expect(h.cloud.info(online)?.region).toBe('us-east');
    // Nothing more was read from the server for it.
    expect(h.calls.filter((call) => call.path === '/cloud-monitors/41/samples')).toHaveLength(1);
  });

  it('shows a monitor Runova paused as paused, with why', async () => {
    const h = harness();
    await h.cloud.enable('t-api', ENABLE);
    h.monitors.set(41, { ...h.monitors.get(41)!, paused: true, suspendedReason: 'over-limit' });
    await h.cloud.refresh();

    expect(h.cloud.paused(h.targets()[0])).toBe(true);
    expect(h.cloud.info(h.targets()[0])?.suspendedReason).toBe('over-limit');
  });

  it('forgets everything when the account signs out', async () => {
    const h = harness();
    await h.cloud.enable('t-api', ENABLE);

    await h.cloud.reset();

    expect(h.cloud.info(h.targets()[0])).toMatchObject({ signedIn: false, region: null });
    expect(h.changed).toHaveBeenLastCalledWith(['t-api']);
  });
});

describe('changes after it is online', () => {
  it('passes a new interval, the alerts and a mute to the server', async () => {
    const h = harness();
    await h.cloud.enable('t-api', ENABLE);
    const online = h.targets()[0];

    await h.cloud.push(online, { intervalSec: 900 });
    await h.cloud.settings('t-api', { notifyTelegram: false, muted: true });

    expect(h.calls.filter((call) => call.method === 'PATCH').map((call) => call.body)).toEqual([
      { intervalSec: 900 },
      { notifyTelegram: false },
    ]);
    expect(h.calls.at(-1)).toMatchObject({ method: 'PUT', path: '/cloud-monitors/41/mutes/me' });
    expect(h.cloud.info(online)).toMatchObject({ notifyTelegram: false, muted: true });
  });

  it('sends a rotated key at once, and nothing for a local monitor', async () => {
    const h = harness();
    await h.cloud.rotate(target(), 'new-key');
    expect(h.api).not.toHaveBeenCalled();

    await h.cloud.enable('t-api', ENABLE);
    await h.cloud.rotate(h.targets()[0], 'new-key');

    expect(h.calls.at(-1)).toEqual({
      method: 'PUT',
      path: '/cloud-monitors/41/secrets/current',
      body: { secret: 'new-key' },
      headers: undefined,
    });
  });

  it('removes the server copy when the monitor is removed', async () => {
    const h = harness();
    await h.cloud.enable('t-api', ENABLE);

    await h.cloud.remove(h.targets()[0]);

    expect(h.monitors.size).toBe(0);
  });
});
