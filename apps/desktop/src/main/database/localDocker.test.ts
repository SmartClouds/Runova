import { describe, expect, it, vi } from 'vitest';
import { createLocalDocker, parseInspect } from './localDocker';

/**
 * This computer's Docker, read for database containers. `docker inspect` carries the image, the
 * environment (the sign-in) and the published ports, which is all one-click connect needs.
 */

const inspectEntry = (overrides: Record<string, unknown> = {}) => ({
  Id: 'abc123',
  Name: '/shop-db-1',
  Config: {
    Image: 'postgres:17-alpine',
    Env: ['POSTGRES_PASSWORD=pw', 'PATH=/usr/bin', 'EMPTY=', 'WITH_EQUALS=a=b'],
    Labels: { 'com.docker.compose.project': 'shop' },
  },
  State: { Running: true },
  NetworkSettings: {
    Ports: {
      '5432/tcp': [
        { HostIp: '0.0.0.0', HostPort: '15432' },
        { HostIp: '::', HostPort: '15432' },
      ],
      '9187/tcp': null,
    },
    Networks: { shop_default: { IPAddress: '172.18.0.2' } },
  },
  ...overrides,
});

describe('parseInspect', () => {
  it('reads the name, image, env, ports and networks', () => {
    expect(parseInspect(JSON.stringify([inspectEntry()]))).toEqual([
      {
        id: 'abc123',
        name: 'shop-db-1',
        image: 'postgres:17-alpine',
        running: true,
        project: 'shop',
        service: null,
        workingDir: null,
        env: { POSTGRES_PASSWORD: 'pw', PATH: '/usr/bin', EMPTY: '', WITH_EQUALS: 'a=b' },
        ports: [
          { containerPort: 5432, hostPort: 15432 },
          { containerPort: 9187, hostPort: null },
        ],
        exposedPorts: [],
        networks: [{ name: 'shop_default', ip: '172.18.0.2' }],
      },
    ]);
  });

  it('reads the compose service, the project folder and the exposed ports', () => {
    const [entry] = parseInspect(
      JSON.stringify([
        inspectEntry({
          Config: {
            Image: 'shop-db:dev',
            Env: [],
            Labels: {
              'com.docker.compose.project': 'shop',
              'com.docker.compose.service': 'db',
              'com.docker.compose.project.working_dir': '/home/me/shop',
            },
            ExposedPorts: { '5432/tcp': {}, '53/udp': {} },
          },
        }),
      ]),
    );
    expect(entry).toMatchObject({
      project: 'shop',
      service: 'db',
      workingDir: '/home/me/shop',
      exposedPorts: [5432],
    });
  });

  it('copes with missing parts', () => {
    const [entry] = parseInspect(
      JSON.stringify([{ Id: 'x', Name: '/x', Config: {}, State: {}, NetworkSettings: {} }]),
    );
    expect(entry).toMatchObject({ image: '', env: {}, ports: [], networks: [], running: false });
  });

  it('ignores UDP ports, which no database here speaks', () => {
    const [entry] = parseInspect(
      JSON.stringify([
        inspectEntry({
          NetworkSettings: { Ports: { '53/udp': null, '6379/tcp': null }, Networks: {} },
        }),
      ]),
    );
    expect(entry?.ports).toEqual([{ containerPort: 6379, hostPort: null }]);
  });
});

describe('createLocalDocker', () => {
  it('lists only database containers, reading all of them with one inspect', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'ps') return 'abc123\ndef456\n';
      return JSON.stringify([
        inspectEntry(),
        inspectEntry({
          Id: 'def456',
          Name: '/web',
          Config: { Image: 'nginx', Env: [], Labels: { 'com.docker.compose.project': 'shop' } },
          NetworkSettings: { Ports: { '80/tcp': null }, Networks: {} },
        }),
        inspectEntry({
          Id: 'ghi789',
          Name: '/built-db',
          Config: { Image: 'shop-db:dev', Env: [], ExposedPorts: { '3306/tcp': {} } },
          State: { Running: false },
          NetworkSettings: {},
        }),
      ]);
    });
    const docker = createLocalDocker(run);
    const list = await docker.listDatabases();
    // A built image counts by the database port it exposes, even while it is stopped.
    expect(list.map((one) => one.name)).toEqual(['shop-db-1', 'built-db']);
    expect(run).toHaveBeenCalledWith(['ps', '-a', '-q', '--no-trunc']);
    expect(run).toHaveBeenCalledWith(['inspect', 'abc123', 'def456']);
    // A project lists every container in it, database or not.
    expect((await docker.listProject('shop')).map((one) => one.name)).toEqual(['shop-db-1', 'web']);
  });

  it('answers an empty list without calling inspect when there are no containers', async () => {
    const run = vi.fn(async () => '');
    expect(await createLocalDocker(run).listDatabases()).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('starts a socat helper on the container network and reads the port it got', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'run') return 'helper999\n';
      if (args[0] === 'port') return '127.0.0.1:49153\n';
      return '';
    });
    const helper = await createLocalDocker(run).startHelper({
      network: 'shop_default',
      host: 'shop-db-1',
      port: 5432,
    });
    expect(helper.port).toBe(49153);
    const runArgs = run.mock.calls.find(([args]) => args[0] === 'run')?.[0] ?? [];
    expect(runArgs).toEqual(
      expect.arrayContaining(['--rm', '--network', 'shop_default', '-p', '127.0.0.1::5432']),
    );
    expect(runArgs.at(-2)).toBe('TCP-LISTEN:5432,fork,reuseaddr');
    expect(runArgs.at(-1)).toBe('TCP:shop-db-1:5432');

    await helper.stop();
    expect(run).toHaveBeenCalledWith(['rm', '-f', 'helper999']);
  });

  it('refuses a helper target that could pass options to docker or socat', async () => {
    const docker = createLocalDocker(vi.fn(async () => ''));
    await expect(
      docker.startHelper({ network: '--privileged', host: 'x', port: 1 }),
    ).rejects.toThrow();
    await expect(docker.startHelper({ network: 'n', host: 'a,b', port: 1 })).rejects.toThrow();
  });
});
