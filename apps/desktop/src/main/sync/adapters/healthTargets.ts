import { syncCollection } from '@runova/core';
import type { HealthStoreState, StoredHealthTarget } from '../../health/store';
import type { SecretPort } from './arrayStore';
import { fromAnotherComputer } from './copyName';
import { recordStoreAdapter } from './recordStore';

/** The health store's reads and its one write queue (health/store.ts). */
export interface HealthTargetsPort {
  read: () => Promise<StoredHealthTarget[]>;
  mutate: <T>(change: (state: HealthStoreState) => T | Promise<T>) => Promise<T>;
  /** `broadcastHealthChanged`, so the windows and the scheduler see the change. */
  changed: (targetIds: string[]) => void;
}

/**
 * Monitors (E48). Every write goes through `mutateHealth`, so a probe finishing at the same
 * moment is never lost. The key travels only sealed. What the probes found is this computer's
 * own and syncs on its own (health-history), and a removed monitor's results go with it.
 */
export function healthTargetsAdapter(
  health: HealthTargetsPort,
  secrets: SecretPort,
  ready?: () => boolean,
) {
  return recordStoreAdapter<StoredHealthTarget>({
    collection: syncCollection('health-targets'),
    area: 'health',
    list: () => health.read(),
    put: (target) =>
      health.mutate((state) => {
        const index = state.targets.findIndex((one) => one.id === target.id);
        if (index === -1) state.targets.push(target);
        else state.targets[index] = target;
      }),
    remove: (id) =>
      health.mutate((state) => {
        state.targets = state.targets.filter((one) => one.id !== id);
        delete state.results[id];
      }),
    id: (target) => target.id,
    secrets,
    ...(ready ? { ready } : {}),
    fromValue: (value) => {
      const target = value as unknown as StoredHealthTarget;
      return {
        ...target,
        appLink: target.appLink ?? null,
        showVersion: target.showVersion !== false,
        secretEnvelope: target.secretEnvelope ?? null,
        secretRotatedAt: target.secretRotatedAt ?? null,
      };
    },
    afterWrite: (ids) => health.changed(ids),
    duplicate: (value) => ({ ...value, name: fromAnotherComputer(value.name, 80) }),
  });
}
