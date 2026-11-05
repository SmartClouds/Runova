import { syncCollection } from '@runova/core';
import type { ErrorTrackingState, StoredErrorConnection } from '../../errorTracking/store';
import type { SecretPort } from './arrayStore';
import { fromAnotherComputer } from './copyName';
import { recordStoreAdapter } from './recordStore';

/** The error tracking store's read and its one write queue (errorTracking/store.ts). */
export interface ErrorTrackingPort {
  read: () => Promise<ErrorTrackingState>;
  mutate: <T>(change: (state: ErrorTrackingState) => T | Promise<T>) => Promise<T>;
  /** `broadcastErrorTrackingChanged('connections')`. */
  changed: () => void;
}

/**
 * Error tracking connections (E48). Only the connections sync: which provider project each
 * Runova project is linked to is a separate list, and a removed connection takes its links with
 * it. The store will not keep a connection without its token, so the policy sends the whole
 * record sealed or not at all. The last check and what went wrong with it are this computer's.
 */
export function errorTrackingAdapter(
  store: ErrorTrackingPort,
  secrets: SecretPort,
  ready?: () => boolean,
) {
  return recordStoreAdapter<StoredErrorConnection>({
    collection: syncCollection('error-tracking'),
    area: 'errorTracking',
    list: async () => (await store.read()).connections,
    put: (connection) =>
      store.mutate((state) => {
        const index = state.connections.findIndex((one) => one.id === connection.id);
        if (index === -1) state.connections.push(connection);
        else state.connections[index] = connection;
      }),
    remove: (id) =>
      store.mutate((state) => {
        state.connections = state.connections.filter((one) => one.id !== id);
        state.links = state.links.filter((link) => link.connectionId !== id);
      }),
    id: (connection) => connection.id,
    secrets,
    ...(ready ? { ready } : {}),
    fromValue: (value, existing) => ({
      ...(value as unknown as StoredErrorConnection),
      checkedAt: existing?.checkedAt ?? null,
      problem: existing?.problem ?? null,
    }),
    afterWrite: () => store.changed(),
    duplicate: (value) => ({ ...value, label: fromAnotherComputer(value.label, 200) }),
  });
}
