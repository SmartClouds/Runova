import { describe, expect, it } from 'vitest';
import type { StoredDatabaseConnection } from '../../database/connectionStore';
import { memorySecrets, sealed } from '../testing/memorySecrets';
import { databaseConnectionsAdapter } from './databaseConnections';

function connection(overrides: Partial<StoredDatabaseConnection> = {}): StoredDatabaseConnection {
  return {
    id: 'd1',
    name: 'Shop',
    engine: 'postgres',
    target: { kind: 'direct', host: 'db.example.com', port: 5432 },
    user: 'app',
    database: 'shop',
    authDatabase: null,
    tls: true,
    srv: false,
    readOnly: false,
    passwordEnvelope: sealed('pg-password'),
    sourceKey: null,
    createdAt: 1,
    lastUsedAt: 8,
    ...overrides,
  } as StoredDatabaseConnection;
}

function memoryStore(initial: StoredDatabaseConnection[] = []) {
  let connections = structuredClone(initial);
  return {
    all: async () => structuredClone(connections),
    put: async (next: StoredDatabaseConnection) => {
      const index = connections.findIndex((one) => one.id === next.id);
      if (index === -1) connections.push(structuredClone(next));
      else connections[index] = structuredClone(next);
    },
    remove: async (id: string) => {
      connections = connections.filter((one) => one.id !== id);
    },
    get: () => connections,
  };
}

describe('databaseConnectionsAdapter', () => {
  it('lists a connection with its password opened', async () => {
    const [item] = await databaseConnectionsAdapter(
      memoryStore([connection()]),
      memorySecrets(),
    ).list();

    expect(item?.value.passwordEnvelope).toEqual({ $secret: 'pg-password' });
  });

  it('leaves out a SQLite file or a container on this computer', async () => {
    const store = memoryStore([
      connection(),
      connection({
        id: 'file',
        engine: 'sqlite',
        target: { kind: 'sqliteFile', path: 'C:\\db.sqlite' },
      } as never),
      connection({
        id: 'local',
        target: { kind: 'localContainer', containerId: 'abc', containerName: 'pg', port: 5432 },
      }),
    ]);

    const items = await databaseConnectionsAdapter(store, memorySecrets()).list();

    expect(items.filter((item) => !item.localOnly).map((item) => item.id)).toEqual(['d1']);
  });

  it('adds a connection from another computer with its password sealed here, never used here', async () => {
    const store = memoryStore();
    const { lastUsedAt: _used, ...shared } = connection();

    await databaseConnectionsAdapter(store, memorySecrets()).apply({
      id: 'd1',
      teamId: null,
      value: { ...shared, passwordEnvelope: { $secret: 'pg-password' } },
    });

    expect(store.get()[0]).toMatchObject({
      passwordEnvelope: sealed('pg-password'),
      lastUsedAt: null,
    });
  });

  it('keeps this computer’s last use, and no password when none came', async () => {
    const store = memoryStore([connection()]);
    const { passwordEnvelope: _password, ...shared } = connection({ name: 'Shop DB' });

    await databaseConnectionsAdapter(store, memorySecrets()).apply({
      id: 'd1',
      teamId: null,
      value: { ...shared, lastUsedAt: 99 },
    });

    expect(store.get()[0]).toMatchObject({
      name: 'Shop DB',
      lastUsedAt: 8,
      passwordEnvelope: null,
    });
  });
});
