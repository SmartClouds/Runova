import { SYNC_COLLECTIONS } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../shared/defaultSettings';
import { memorySecrets } from '../testing/memorySecrets';
import { createSyncAdapters, type SyncAdapterPorts } from './index';

function ports(overrides: Partial<SyncAdapterPorts> = {}): SyncAdapterPorts {
  const none = async () => [];
  const nothing = async () => undefined;
  return {
    secrets: memorySecrets(),
    projects: { getProjects: none, setProjects: nothing },
    environments: { getProjectEnvironments: none, setProjectEnvironments: nothing },
    sshServers: { getSshServers: none, setSshServers: nothing },
    rdpServers: { getRdpServers: none, setRdpServers: nothing },
    databaseConnections: { all: none, put: nothing, remove: nothing },
    healthTargets: {
      read: none,
      mutate: async (change) => change({ targets: [], results: {} }),
      changed: () => undefined,
    },
    errorTracking: {
      read: async () => ({ connections: [], links: [] }),
      mutate: async (change) => change({ connections: [], links: [] }),
      changed: () => undefined,
    },
    apiCollections: { all: none, put: nothing, remove: nothing },
    promptTemplates: { getTemplates: none, setTemplates: nothing },
    blueprints: { getBlueprints: none, setBlueprints: nothing },
    settings: {
      getSettings: async () => structuredClone(DEFAULT_SETTINGS),
      updateSettings: async (change) => change(structuredClone(DEFAULT_SETTINGS)),
    },
    vault: {
      isUnlocked: () => true,
      entriesForSync: () => [],
      putFromSync: nothing,
      removeFromSync: nothing,
    },
    ...overrides,
  };
}

describe('createSyncAdapters', () => {
  it('builds one adapter for every collection the device syncs, monitoring history aside', () => {
    const ids = createSyncAdapters(ports()).map((adapter) => adapter.collection.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(
      SYNC_COLLECTIONS.map((c) => c.id)
        .filter((id) => id !== 'health-history')
        .sort(),
    );
  });

  it('writes projects first, then environments, so what hangs off them has a home', () => {
    const ids = createSyncAdapters(ports()).map((adapter) => adapter.collection.id);

    expect(ids.slice(0, 2)).toEqual(['projects', 'environments']);
  });

  it('holds back every store with sealed secrets while the Servers passkey is locked', () => {
    let unlocked = false;
    const adapters = createSyncAdapters(ports({ secretsReady: () => unlocked }));
    const waiting = () =>
      adapters.filter((adapter) => adapter.ready?.() === false).map((a) => a.collection.id);

    expect(waiting().sort()).toEqual([
      'database-connections',
      'environments',
      'error-tracking',
      'health-targets',
      'rdp-servers',
      'ssh-servers',
    ]);
    unlocked = true;
    expect(waiting()).toEqual([]);
  });

  it('lists every store through its port', async () => {
    for (const adapter of createSyncAdapters(ports())) {
      const items = await adapter.list();
      expect(items.length).toBe(adapter.collection.id === 'settings' ? 1 : 0);
    }
  });
});
