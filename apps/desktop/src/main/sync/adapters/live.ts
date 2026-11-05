import { collectionStore } from '../../apiClient/collectionStore';
import { getDatabaseConnections } from '../../database';
import {
  broadcastErrorTrackingChanged,
  mutateErrorTracking,
  readErrorTracking,
} from '../../errorTracking/store';
import { broadcastHealthChanged, mutateHealth, readHealthTargets } from '../../health/store';
import { decryptSecret, encryptSecret, getVaultStatus } from '../../ssh/vault';
import { store } from '../../store';
import { getVaultService } from '../../vault';
import type { SyncAdapter } from '../types';
import { createSyncAdapters } from './index';

/**
 * The sync adapters over the app's real stores. Each reads and writes through the store's own
 * functions and write queue, so the engine is never a second writer.
 */

let serversLocked = false;

/** Reads whether the Servers passkey is set and locked, for the synchronous `ready` checks. */
export async function refreshSecretsState(): Promise<void> {
  const status = await getVaultStatus();
  serversLocked = status.hasPasskey && !status.unlocked;
}

export function liveSyncAdapters(): SyncAdapter[] {
  const vault = getVaultService();
  return createSyncAdapters({
    secrets: {
      open: ((envelope: Parameters<typeof decryptSecret>[0]) => decryptSecret(envelope)) as never,
      seal: (plain) => encryptSecret(plain),
    },
    secretsReady: () => !serversLocked,
    projects: store,
    environments: store,
    sshServers: store,
    rdpServers: store,
    databaseConnections: {
      all: async () => (await getDatabaseConnections()?.all()) ?? [],
      put: async (connection) => {
        const connections = getDatabaseConnections();
        if (!connections) throw new Error('The Database section has not started yet.');
        await connections.put(connection);
      },
      remove: async (id) => {
        await getDatabaseConnections()?.remove(id);
      },
    },
    healthTargets: {
      read: readHealthTargets,
      mutate: mutateHealth,
      changed: broadcastHealthChanged,
    },
    errorTracking: {
      read: readErrorTracking,
      mutate: mutateErrorTracking,
      changed: () => broadcastErrorTrackingChanged('connections'),
    },
    apiCollections: {
      all: () => collectionStore.all(),
      put: (meta, collection) => collectionStore.put(meta, collection),
      remove: (id) => collectionStore.remove(id),
    },
    promptTemplates: store,
    blueprints: store,
    settings: store,
    vault: {
      isUnlocked: () => vault.isUnlocked(),
      entriesForSync: () => vault.entriesForSync(),
      putFromSync: (entry) => vault.putFromSync(entry),
      removeFromSync: (id) => vault.removeFromSync(id),
    },
  });
}
