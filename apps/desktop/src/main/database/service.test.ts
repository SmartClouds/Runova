import { PassThrough } from 'node:stream';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContainerDetails,
  ContainerList,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useTempUserData } from '../../test/main/ipcHarness';
import type { DbDriver, DriverConnectOptions, DriverQueryOptions } from './drivers/types';
import { DriverError } from './drivers/types';
import type { LocalContainer, LocalDocker } from './localDocker';
import type { DatabaseServiceDeps, ServerDocker } from './service';

/**
 * The Database section's service with fake Docker and fake drivers: discovery, one-click connect,
 * the password fallback, and which queries wait for the user.
 */

const userData = useTempUserData();

beforeAll(async () => {
  await import('./service');
  await import('./connectionStore');
}, 120_000);

let serviceModule: typeof import('./service');
let storeModule: typeof import('./connectionStore');

beforeEach(async () => {
  serviceModule = await import('./service');
  storeModule = await import('./connectionStore');
});

const serverList: ContainerList = {
  groups: [
    {
      project: 'shop',
      containers: [
        {
          id: 'c-pg',
          name: 'shop-db',
          image: 'postgres:17',
          imageId: 'i1',
          state: 'running',
          status: 'Up',
          health: 'healthy',
          createdAtUnixMs: 1,
          ports: [{ privatePort: 5432, protocol: 'tcp' }],
          composeProject: 'shop',
        },
        {
          id: 'c-web',
          name: 'shop-web',
          image: 'nginx',
          imageId: 'i2',
          state: 'running',
          status: 'Up',
          health: 'none',
          createdAtUnixMs: 1,
          ports: [],
        },
      ] as never,
    },
  ],
};

const details = (env = true): ContainerDetails =>
  ({
    summary: serverList.groups[0]?.containers[0],
    command: [],
    entrypoint: [],
    envKeys: env ? ['POSTGRES_PASSWORD'] : [],
    labels: [],
    mounts: [],
    networks: [{ network: 'shop_default', ipAddress: '172.20.0.5' }],
    restartPolicy: 'always',
    restartCount: 0,
    tty: false,
    privileged: false,
  }) as unknown as ContainerDetails;

function fakeDriver(overrides: Partial<DbDriver> = {}): DbDriver {
  return {
    engine: 'postgres',
    serverVersion: async () => '17.2',
    listObjects: async () => [],
    describe: async () => {
      throw new Error('unused');
    },
    readRows: async () => {
      throw new Error('unused');
    },
    query: vi.fn(async (_text: string, _options: DriverQueryOptions) => ({ results: [] })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

interface Harness {
  service: InstanceType<typeof serviceModule.DatabaseService>;
  opened: DriverConnectOptions[];
  driver: DbDriver;
  serverDocker: ServerDocker;
  localDocker: LocalDocker;
  streams: { serverId: string; host: string; port: number }[];
}

function harness(
  options: {
    env?: Record<string, string>;
    open?: (options: DriverConnectOptions) => Promise<DbDriver>;
    local?: LocalContainer[];
    reachable?: boolean;
  } = {},
): Harness {
  const opened: DriverConnectOptions[] = [];
  const driver = fakeDriver();
  const streams: Harness['streams'] = [];
  const env = options.env ?? { POSTGRES_PASSWORD: 'secret-pw', POSTGRES_DB: 'shop' };
  const serverDocker: ServerDocker = {
    listContainers: vi.fn(async () => serverList),
    inspect: vi.fn(async () => details()),
    revealEnv: vi.fn(async () => Object.entries(env).map(([name, value]) => ({ name, value }))),
  };
  const local = options.local ?? [];
  const localDocker: LocalDocker = {
    listDatabases: vi.fn(async () => local),
    inspect: vi.fn(async (idOrName: string) => {
      const found = local.find((one) => one.id === idOrName || one.name === idOrName);
      if (!found) throw new Error('no such container');
      return found;
    }),
    startHelper: vi.fn(async () => ({ port: 49999, stop: vi.fn(async () => undefined) })),
  };
  const deps: DatabaseServiceDeps = {
    connections: new storeModule.DatabaseConnectionStore(userData.dataFile('databases.json')),
    openDriver: async (connectOptions) => {
      opened.push(connectOptions);
      return options.open ? options.open(connectOptions) : driver;
    },
    serverDocker,
    serverStream: async (serverId, host, port) => {
      streams.push({ serverId, host, port });
      return new PassThrough();
    },
    localDocker,
    containerAddressesReachable: options.reachable ?? false,
  };
  return {
    service: new serviceModule.DatabaseService(deps),
    opened,
    driver,
    serverDocker,
    localDocker,
    streams,
  };
}

const localPg = (overrides: Partial<LocalContainer> = {}): LocalContainer => ({
  id: 'local-1',
  name: 'dev-pg',
  image: 'postgres:16',
  running: true,
  project: null,
  env: { POSTGRES_PASSWORD: 'local-pw' },
  ports: [{ containerPort: 5432, hostPort: 55432 }],
  networks: [{ name: 'bridge', ip: '172.17.0.2' }],
  ...overrides,
});

describe('discover', () => {
  it('lists the database containers on a server and skips the rest', async () => {
    const { service } = harness();
    const found = await service.discover('s1');
    expect(found.problems).toEqual([]);
    expect(found.candidates).toEqual([
      {
        key: 'server:s1:shop-db',
        source: 'server',
        serverId: 's1',
        containerId: 'c-pg',
        containerName: 'shop-db',
        image: 'postgres:17',
        engine: 'postgres',
        running: true,
        project: 'shop',
        connectionId: null,
      },
    ]);
  });

  it('lists local containers, and says so when Docker is not running here', async () => {
    const { service, localDocker } = harness({ local: [localPg()] });
    expect((await service.discover(null)).candidates.map((one) => one.key)).toEqual([
      'local:dev-pg',
    ]);
    vi.mocked(localDocker.listDatabases).mockRejectedValueOnce(new Error('pipe not found'));
    const failed = await service.discover(null);
    expect(failed.candidates).toEqual([]);
    expect(failed.problems[0]?.message).toMatch(/docker on this computer is not running/i);
  });
});

describe('one-click connect', () => {
  it('reads the sign-in from the container, tunnels to it over SSH, and saves the connection', async () => {
    const { service, opened, streams } = harness();
    const result = await service.connectCandidate({ serverId: 's1', containerId: 'c-pg' });
    expect('sessionId' in result).toBe(true);
    if (!('sessionId' in result)) return;

    expect(result.serverVersion).toBe('17.2');
    expect(result.connection).toMatchObject({
      name: 'shop-db',
      engine: 'postgres',
      user: 'postgres',
      database: 'shop',
      hasPassword: true,
      target: { kind: 'server', serverId: 's1', host: '172.20.0.5', port: 5432 },
    });
    expect(JSON.stringify(result)).not.toContain('secret-pw');
    // The driver signs in at a loopback forward with the password from the env.
    expect(opened[0]).toMatchObject({ host: '127.0.0.1', password: 'secret-pw', user: 'postgres' });

    // The card now knows it is saved, and a second click reuses the same connection.
    const again = await service.discover('s1');
    expect(again.candidates[0]?.connectionId).toBe(result.connection.id);
    const second = await service.connectCandidate({ serverId: 's1', containerId: 'c-pg' });
    expect('sessionId' in second && second.connection.id).toBe(result.connection.id);
    expect(await service.listConnections()).toHaveLength(1);
    void streams;
  });

  it('passes a step-up along to the server when one is given', async () => {
    const { service, serverDocker } = harness();
    await service.connectCandidate({ serverId: 's1', containerId: 'c-pg', password: 'acct' });
    expect(serverDocker.revealEnv).toHaveBeenCalledWith({
      serverId: 's1',
      containerId: 'c-pg',
      password: 'acct',
    });
  });

  it('lets the step-up refusal through so the renderer can ask for it', async () => {
    const { service, serverDocker } = harness();
    vi.mocked(serverDocker.revealEnv).mockRejectedValueOnce(
      new Error('[core:stepUpRequired] Confirm your password'),
    );
    await expect(service.connectCandidate({ serverId: 's1', containerId: 'c-pg' })).rejects.toThrow(
      /stepUpRequired/,
    );
  });

  it('asks only for the password when the environment has none', async () => {
    const { service } = harness({ env: {} });
    expect(await service.connectCandidate({ serverId: 's1', containerId: 'c-pg' })).toEqual({
      needsPassword: true,
      reason: 'missing',
      engine: 'postgres',
      user: 'postgres',
    });
    const done = await service.connectCandidate({
      serverId: 's1',
      containerId: 'c-pg',
      databasePassword: 'typed',
    });
    expect('sessionId' in done).toBe(true);
  });

  it('answers needsPassword when the saved password is refused, and takes a new one', async () => {
    let attempts = 0;
    const { service } = harness({
      open: async (options) => {
        attempts++;
        if (options.password !== 'right') throw new DriverError('password failed', true);
        return fakeDriver();
      },
    });
    expect(await service.connectCandidate({ serverId: 's1', containerId: 'c-pg' })).toMatchObject({
      needsPassword: true,
      reason: 'refused',
    });
    const [saved] = await service.listConnections();
    const fixed = await service.connect(saved?.id ?? '', 'right');
    expect('sessionId' in fixed).toBe(true);
    expect(attempts).toBe(2);
  });

  it('connects to a local container on its published port', async () => {
    const { service, opened } = harness({ local: [localPg()] });
    const result = await service.connectCandidate({ serverId: null, containerId: 'local-1' });
    expect('sessionId' in result).toBe(true);
    expect(opened[0]).toMatchObject({ host: '127.0.0.1', port: 55432, password: 'local-pw' });
  });

  it('uses the container address where it can be reached, and a helper where it cannot', async () => {
    const unpublished = localPg({ ports: [{ containerPort: 5432, hostPort: null }] });
    const linux = harness({ local: [unpublished], reachable: true });
    await linux.service.connectCandidate({ serverId: null, containerId: 'local-1' });
    expect(linux.opened[0]).toMatchObject({ host: '172.17.0.2', port: 5432 });

    const desktop = harness({ local: [unpublished], reachable: false });
    const result = await desktop.service.connectCandidate({
      serverId: null,
      containerId: 'local-1',
    });
    expect(desktop.opened[0]).toMatchObject({ host: '127.0.0.1', port: 49999 });
    expect(desktop.localDocker.startHelper).toHaveBeenCalledWith({
      network: 'bridge',
      host: 'dev-pg',
      port: 5432,
    });
    // Disconnecting stops the helper.
    const helper = await vi.mocked(desktop.localDocker.startHelper).mock.results[0]?.value;
    if ('sessionId' in result) await desktop.service.disconnect(result.sessionId);
    expect(helper.stop).toHaveBeenCalled();
  });

  it('says a stopped container has to be started first', async () => {
    const { service } = harness({ local: [localPg({ running: false })] });
    await expect(
      service.connectCandidate({ serverId: null, containerId: 'local-1' }),
    ).rejects.toThrow(/not running/);
  });

  it('turns down a container that is not a database', async () => {
    const { service } = harness({ local: [localPg({ image: 'nginx' })] });
    await expect(
      service.connectCandidate({ serverId: null, containerId: 'local-1' }),
    ).rejects.toThrow(/does not run a database/);
  });
});

describe('queries', () => {
  async function connected(readOnly = false) {
    const h = harness();
    const result = await h.service.connectCandidate({ serverId: 's1', containerId: 'c-pg' });
    if (!('sessionId' in result)) throw new Error('not connected');
    if (readOnly) {
      await h.service.saveConnection({ ...result.connection, readOnly: true });
      await h.service.disconnect(result.sessionId);
      const again = await h.service.connect(result.connection.id);
      if (!('sessionId' in again)) throw new Error('not connected');
      return { ...h, sessionId: again.sessionId };
    }
    return { ...h, sessionId: result.sessionId };
  }

  it('runs a read straight away, in a read-only run', async () => {
    const { service, driver, sessionId } = await connected();
    expect(await service.query({ sessionId, queryId: 'q', text: 'SELECT 1' })).toEqual({
      status: 'done',
      results: [],
    });
    expect(vi.mocked(driver.query).mock.calls[0]?.[1]).toMatchObject({
      readOnly: true,
      maxRows: 1000,
    });
  });

  it('runs a plain write from the editor without asking, but not in a read-only run', async () => {
    const { service, driver, sessionId } = await connected();
    const outcome = await service.query({
      sessionId,
      queryId: 'q',
      text: 'INSERT INTO t VALUES (1)',
    });
    expect(outcome.status).toBe('done');
    expect(vi.mocked(driver.query).mock.calls[0]?.[1].readOnly).toBe(false);
  });

  it('holds a destructive statement from the editor until it is confirmed', async () => {
    const { service, driver, sessionId } = await connected();
    expect(await service.query({ sessionId, queryId: 'q', text: 'DROP TABLE t' })).toEqual({
      status: 'needsConfirmation',
      classification: { kind: 'ddl', destructive: true },
    });
    expect(driver.query).not.toHaveBeenCalled();
    await service.query({ sessionId, queryId: 'q', text: 'DROP TABLE t', confirmed: true });
    expect(driver.query).toHaveBeenCalledTimes(1);
  });

  it('holds every write the AI wrote, but runs its reads', async () => {
    const { service, sessionId } = await connected();
    expect(
      (
        await service.query({
          sessionId,
          queryId: 'q',
          text: 'UPDATE t SET a = 1 WHERE id = 2',
          origin: 'ai',
        })
      ).status,
    ).toBe('needsConfirmation');
    expect(
      (await service.query({ sessionId, queryId: 'q', text: 'SELECT * FROM t', origin: 'ai' }))
        .status,
    ).toBe('done');
  });

  it('holds every write on a read-only connection', async () => {
    const { service, sessionId } = await connected(true);
    expect(
      (await service.query({ sessionId, queryId: 'q', text: 'INSERT INTO t VALUES (1)' })).status,
    ).toBe('needsConfirmation');
  });

  it('reports a failed statement and a cancelled run', async () => {
    const { service, driver, sessionId } = await connected();
    vi.mocked(driver.query).mockResolvedValueOnce({
      results: [],
      error: { message: 'relation "t" does not exist', statementIndex: 0 },
    });
    expect(await service.query({ sessionId, queryId: 'q', text: 'SELECT * FROM t' })).toEqual({
      status: 'failed',
      results: [],
      error: 'relation "t" does not exist',
      statementIndex: 0,
    });

    vi.mocked(driver.query).mockImplementationOnce(
      (_text, options) =>
        new Promise((resolve) =>
          options.signal.addEventListener('abort', () => resolve({ results: [], cancelled: true })),
        ),
    );
    const pending = service.query({ sessionId, queryId: 'long', text: 'SELECT pg_sleep(9)' });
    await vi.waitFor(() => expect(service.cancelQuery(sessionId, 'long')).toBe(true));
    expect((await pending).status).toBe('cancelled');
    expect(service.cancelQuery(sessionId, 'long')).toBe(false);
  });

  it('keeps the row cap within bounds', async () => {
    const { service, driver, sessionId } = await connected();
    await service.query({ sessionId, queryId: 'q', text: 'SELECT 1', maxRows: 10_000_000 });
    expect(vi.mocked(driver.query).mock.calls[0]?.[1].maxRows).toBe(50_000);
  });

  it('says the connection is closed after a disconnect, and closes the driver', async () => {
    const { service, driver, sessionId } = await connected();
    await service.disconnect(sessionId);
    expect(driver.close).toHaveBeenCalled();
    await expect(service.query({ sessionId, queryId: 'q', text: 'SELECT 1' })).rejects.toThrow(
      /closed/,
    );
  });

  it('closes sessions left idle', async () => {
    let now = 1_000_000;
    const h = harness();
    const deps = (h.service as unknown as { deps: DatabaseServiceDeps }).deps;
    const service = new serviceModule.DatabaseService({ ...deps, now: () => now });
    const result = await service.connectCandidate({ serverId: 's1', containerId: 'c-pg' });
    if (!('sessionId' in result)) throw new Error('not connected');
    now += 31 * 60_000;
    await service.sweepIdle();
    expect(h.driver.close).toHaveBeenCalled();
  });

  it('gives the AI the tables and columns of the database in use, and rows only when allowed', async () => {
    const h = harness({
      open: async () =>
        fakeDriver({
          listObjects: async (parent, kind) => {
            if (!parent) {
              return [
                {
                  kind: 'database',
                  name: 'shop',
                  ref: { database: 'shop', name: 'shop' },
                  hasChildren: true,
                  rowEstimate: null,
                },
                {
                  kind: 'database',
                  name: 'other',
                  ref: { database: 'other', name: 'other' },
                  hasChildren: true,
                  rowEstimate: null,
                },
              ];
            }
            if (kind === 'database') {
              return [
                {
                  kind: 'schema',
                  name: 'public',
                  ref: { database: 'shop', schema: 'public', name: 'public' },
                  hasChildren: true,
                  rowEstimate: null,
                },
              ];
            }
            return [
              {
                kind: 'table',
                name: 'orders',
                ref: { database: 'shop', schema: 'public', name: 'orders' },
                hasChildren: false,
                rowEstimate: 2,
              },
            ];
          },
          describe: async (ref) => ({
            ref,
            kind: 'table',
            columns: [
              {
                name: 'id',
                type: 'integer',
                nullable: false,
                defaultValue: null,
                primaryKey: true,
                generated: true,
              },
              {
                name: 'total',
                type: 'numeric',
                nullable: true,
                defaultValue: null,
                primaryKey: false,
                generated: false,
              },
            ],
            indexes: [],
            rowEstimate: 2,
            definition: null,
          }),
          readRows: vi.fn(async () => ({
            result: {
              columns: [
                { name: 'id', type: null },
                { name: 'total', type: null },
              ],
              rows: [[1, '9.50']],
              affectedRows: null,
              truncated: false,
              durationMs: 1,
              statement: '',
              notice: null,
            },
            total: 1,
            keyColumns: ['id'],
          })),
        }),
    });
    const result = await h.service.connectCandidate({ serverId: 's1', containerId: 'c-pg' });
    if (!('sessionId' in result)) throw new Error('not connected');
    const without = await h.service.aiContext({
      sessionId: result.sessionId,
      includeSamples: false,
    });
    expect(without).toEqual({
      database: 'shop',
      schema: [
        {
          name: 'public.orders',
          columns: [
            { name: 'id', type: 'integer', primaryKey: true },
            { name: 'total', type: 'numeric' },
          ],
        },
      ],
      samples: [],
    });
    const withRows = await h.service.aiContext({
      sessionId: result.sessionId,
      includeSamples: true,
    });
    expect(withRows.samples).toEqual([
      { table: 'public.orders', columns: ['id', 'total'], rows: [[1, '9.50']] },
    ]);
  });

  it('removing a connection closes its sessions', async () => {
    const { service, driver, sessionId } = await connected();
    const [saved] = await service.listConnections();
    await service.removeConnection(saved?.id ?? '');
    expect(driver.close).toHaveBeenCalled();
    expect(await service.listConnections()).toEqual([]);
    await expect(
      service.listObjects({ sessionId, parent: null, parentKind: null }),
    ).rejects.toThrow(/closed/);
  });
});
