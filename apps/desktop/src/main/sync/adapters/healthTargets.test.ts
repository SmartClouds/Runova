import { describe, expect, it } from 'vitest';
import type { HealthStoreState, StoredHealthTarget } from '../../health/store';
import { memorySecrets, sealed } from '../testing/memorySecrets';
import { healthTargetsAdapter } from './healthTargets';

function target(overrides: Partial<StoredHealthTarget> = {}): StoredHealthTarget {
  return {
    id: 't1',
    projectId: 'p1',
    environmentId: null,
    name: 'API',
    serverLabel: null,
    serverLink: null,
    appLink: null,
    url: 'https://shop.example.com/_runova/health',
    intervalSec: 60,
    timeoutSec: 10,
    authMode: 'bearer',
    basicUser: null,
    allowInsecure: false,
    autoDiagnose: true,
    showVersion: true,
    createdAt: 1,
    updatedAt: 1,
    paused: false,
    secretEnvelope: sealed('health-key'),
    secretRotatedAt: null,
    ...overrides,
  };
}

function memoryHealth(targets: StoredHealthTarget[] = []) {
  let state: HealthStoreState = {
    targets: structuredClone(targets),
    results: Object.fromEntries(targets.map((t) => [t.id, { lastCheckedAt: 1 } as never])),
  };
  const mutations: string[] = [];
  const changed: string[][] = [];
  return {
    port: {
      read: async () => structuredClone(state.targets),
      mutate: async <T>(change: (s: HealthStoreState) => T | Promise<T>): Promise<T> => {
        mutations.push('mutate');
        const draft = structuredClone(state);
        const result = await change(draft);
        state = draft;
        return result;
      },
      changed: (ids: string[]) => changed.push(ids),
    },
    state: () => state,
    mutations,
    changed,
  };
}

describe('healthTargetsAdapter', () => {
  it('lists a monitor with its key opened', async () => {
    const health = memoryHealth([target()]);

    const [item] = await healthTargetsAdapter(health.port, memorySecrets()).list();

    expect(item?.value.secretEnvelope).toEqual({ $secret: 'health-key' });
  });

  it('writes through the health queue and tells every window', async () => {
    const health = memoryHealth();
    const { secretEnvelope: _key, ...shared } = target();

    await healthTargetsAdapter(health.port, memorySecrets()).apply({
      id: 't1',
      teamId: null,
      value: { ...shared, secretEnvelope: { $secret: 'health-key' } },
    });

    expect(health.mutations).toEqual(['mutate']);
    expect(health.state().targets).toEqual([target()]);
    expect(health.changed).toEqual([['t1']]);
  });

  it('fills what an older Runova left out, and no key when none came', async () => {
    const health = memoryHealth();
    const {
      secretEnvelope: _key,
      appLink: _app,
      showVersion: _version,
      secretRotatedAt: _rotated,
      ...shared
    } = target();

    await healthTargetsAdapter(health.port, memorySecrets()).apply({
      id: 't1',
      teamId: null,
      value: shared,
    });

    expect(health.state().targets[0]).toMatchObject({
      secretEnvelope: null,
      secretRotatedAt: null,
      appLink: null,
      showVersion: true,
    });
  });

  it('forgets a removed monitor’s results along with it', async () => {
    const health = memoryHealth([target()]);

    await healthTargetsAdapter(health.port, memorySecrets()).remove('t1');

    expect(health.state()).toEqual({ targets: [], results: {} });
    expect(health.changed).toEqual([['t1']]);
  });
});
