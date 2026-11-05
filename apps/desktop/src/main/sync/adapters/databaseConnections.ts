import { syncCollection } from '@runova/core';
import type { StoredDatabaseConnection } from '../../database/connectionStore';
import type { SecretPort } from './arrayStore';
import { fromAnotherComputer } from './copyName';
import { recordStoreAdapter } from './recordStore';

/** The parts of `DatabaseConnectionStore` sync uses. */
export interface DatabaseConnectionsPort {
  all: () => Promise<StoredDatabaseConnection[]>;
  put: (connection: StoredDatabaseConnection) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/**
 * Saved database connections (E48). A connection to a SQLite file or a container on this
 * computer points at something only this computer has, and the store will not keep one without
 * its file path, so those never sync. Every other one does, with its password sealed and the
 * last use kept per computer.
 */
export function databaseConnectionsAdapter(
  store: DatabaseConnectionsPort,
  secrets: SecretPort,
  ready?: () => boolean,
) {
  return recordStoreAdapter<StoredDatabaseConnection>({
    collection: syncCollection('database-connections'),
    area: 'database',
    list: () => store.all(),
    put: (connection) => store.put(connection),
    remove: (id) => store.remove(id),
    id: (connection) => connection.id,
    secrets,
    ...(ready ? { ready } : {}),
    syncs: (connection) =>
      connection.target.kind !== 'sqliteFile' && connection.target.kind !== 'localContainer',
    fromValue: (value, existing) => {
      const connection = value as unknown as StoredDatabaseConnection;
      return {
        ...connection,
        passwordEnvelope: connection.passwordEnvelope ?? null,
        sourceKey: connection.sourceKey ?? null,
        lastUsedAt: existing?.lastUsedAt ?? null,
      };
    },
    duplicate: (value) => ({ ...value, name: fromAnotherComputer(value.name, 200) }),
  });
}
