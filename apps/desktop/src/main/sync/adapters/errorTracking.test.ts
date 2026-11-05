import { describe, expect, it } from 'vitest';
import type { ErrorTrackingState, StoredErrorConnection } from '../../errorTracking/store';
import { memorySecrets, sealed } from '../testing/memorySecrets';
import { errorTrackingAdapter } from './errorTracking';

function connection(overrides: Partial<StoredErrorConnection> = {}): StoredErrorConnection {
  return {
    id: 'c1',
    provider: 'sentry',
    label: 'Acme',
    host: 'https://sentry.io',
    apiBase: 'https://de.sentry.io',
    orgSlug: 'acme',
    orgName: 'Acme',
    scopes: ['org:read'],
    canWrite: true,
    createdAt: 1,
    checkedAt: 2,
    problem: 'Token rejected',
    tokenEnvelope: sealed('sntryu_token'),
    ...overrides,
  };
}

const link = {
  projectId: 'p1',
  connectionId: 'c1',
  remoteProjectId: '102',
  remoteSlug: 'api',
  remoteName: 'api',
};

function memoryErrorTracking(initial: Partial<ErrorTrackingState> = {}) {
  let state: ErrorTrackingState = { connections: [], links: [], ...structuredClone(initial) };
  let changed = 0;
  return {
    port: {
      read: async () => structuredClone(state),
      mutate: async <T>(change: (s: ErrorTrackingState) => T | Promise<T>): Promise<T> => {
        const draft = structuredClone(state);
        const result = await change(draft);
        state = draft;
        return result;
      },
      changed: () => {
        changed += 1;
      },
    },
    state: () => state,
    changed: () => changed,
  };
}

describe('errorTrackingAdapter', () => {
  it('lists only the connections, each with its token opened', async () => {
    const store = memoryErrorTracking({ connections: [connection()], links: [link] });

    const items = await errorTrackingAdapter(store.port, memorySecrets()).list();

    expect(items).toHaveLength(1);
    expect(items[0]?.value.tokenEnvelope).toEqual({ $secret: 'sntryu_token' });
    expect(items[0]?.value).not.toHaveProperty('links');
  });

  it('adds a connection with its token sealed here and no check made yet', async () => {
    const store = memoryErrorTracking();
    const { checkedAt: _checked, problem: _problem, ...shared } = connection();

    await errorTrackingAdapter(store.port, memorySecrets()).apply({
      id: 'c1',
      teamId: null,
      value: { ...shared, tokenEnvelope: { $secret: 'sntryu_token' } },
    });

    expect(store.state().connections).toEqual([connection({ checkedAt: null, problem: null })]);
    expect(store.changed()).toBe(1);
  });

  it('keeps this computer’s last check on an update', async () => {
    const store = memoryErrorTracking({ connections: [connection()] });

    await errorTrackingAdapter(store.port, memorySecrets()).apply({
      id: 'c1',
      teamId: null,
      value: {
        ...connection({ label: 'Acme Inc', checkedAt: 50, problem: null }),
        tokenEnvelope: { $secret: 'sntryu_token' },
      },
    });

    expect(store.state().connections[0]).toMatchObject({
      label: 'Acme Inc',
      checkedAt: 2,
      problem: 'Token rejected',
    });
  });

  it('drops a removed connection’s project links with it', async () => {
    const store = memoryErrorTracking({ connections: [connection()], links: [link] });

    await errorTrackingAdapter(store.port, memorySecrets()).remove('c1');

    expect(store.state()).toEqual({ connections: [], links: [] });
  });
});
