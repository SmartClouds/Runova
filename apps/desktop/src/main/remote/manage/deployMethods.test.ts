import { MANAGE_METHODS } from '@runova/protocol';
import { describe, expect, it, vi } from 'vitest';
import { deployMethods, type ManageDeployDeps } from './deployMethods';
import { ManageError } from './session';

const context = { phone: { key: 'k', name: 'Runova app', scopes: ['deploy' as const] } };

const container = {
  id: 'c1',
  name: 'web',
  image: 'nginx',
  imageId: 'i',
  state: 'running',
  status: 'Up 2 hours',
  health: 'healthy',
  createdAtUnixMs: 1,
  ports: [],
};
const stack = {
  id: 's1',
  name: 'shop',
  status: 'running',
  createdAtUnixMs: 1,
  updatedAtUnixMs: 2,
  revisionCount: 3,
  liveRevision: 3,
  runningContainers: 2,
  containers: 3,
};

function deps(change: Partial<ManageDeployDeps> = {}): ManageDeployDeps {
  return {
    servers: async () => [
      { id: 'srv1', nickname: 'Prod', host: '10.0.0.1', username: 'root', enrolled: true } as never,
    ],
    connection: () => ({ serverId: 'srv1', state: 'online', since: 1 }) as never,
    containers: async () => ({ groups: [{ containers: [container] }] }) as never,
    stacks: async () => [stack] as never,
    alerts: async () => [],
    certificates: async () => [],
    exposure: async () => null,
    backups: async () =>
      [
        {
          id: 'b1',
          planName: 'Nightly',
          trigger: 'schedule',
          state: 'succeeded',
          startedAtUnixMs: 5,
        },
      ] as never,
    health: async () => ({ version: '1.2.3' }) as never,
    containerAction: async () => container as never,
    logs: async () =>
      [
        { stream: 'stdout', timestamp: 't', atUnixMs: 1, text: 'started' },
        { stream: 'stderr', timestamp: 't', atUnixMs: 2, text: 'oops' },
      ] as never,
    stackAction: async () => ({ id: 'j' }) as never,
    redeploy: async () => ({ id: 'j' }) as never,
    now: () => 1000,
    timeoutMs: 40,
    ...change,
  };
}

function call(d: ManageDeployDeps, method: string, params?: unknown) {
  return deployMethods(d)[method](params, context);
}

describe('deploy methods', () => {
  it('lists servers with how each is connected, and no login name', async () => {
    const [server] = (await call(deps(), 'deploy.servers')) as Record<string, unknown>[];

    expect(server).toEqual({
      id: 'srv1',
      name: 'Prod',
      host: '10.0.0.1',
      state: 'online',
      problem: null,
    });
  });

  it('puts a server overview together', async () => {
    const result = (await call(deps(), 'deploy.overview', { serverId: 'srv1' })) as {
      reachable: boolean;
      version: string;
      containers: { name: string }[];
      stacks: { name: string; running: number; total: number; canRedeploy: boolean }[];
      lastBackup: { state: string; planName: string };
    };

    expect(result.reachable).toBe(true);
    expect(result.version).toBe('1.2.3');
    expect(result.containers[0].name).toBe('web');
    expect(result.stacks[0]).toMatchObject({
      name: 'shop',
      running: 2,
      total: 3,
      canRedeploy: true,
    });
    expect(result.lastBackup).toMatchObject({ state: 'succeeded', planName: 'Nightly' });
  });

  it('lists what is wrong, as the desktop would', async () => {
    const looping = { ...container, state: 'restarting', status: 'Restarting (1) 3 seconds ago' };

    const result = (await call(
      deps({ containers: async () => ({ groups: [{ containers: [looping] }] }) as never }),
      'deploy.overview',
      { serverId: 'srv1' },
    )) as { problems: { severity: string; title: string }[] };

    expect(result.problems[0].severity).toBe('critical');
  });

  it('keeps what it could read when one part fails', async () => {
    const result = (await call(
      deps({
        certificates: async () => {
          throw new Error('no nginx');
        },
      }),
      'deploy.overview',
      { serverId: 'srv1' },
    )) as { reachable: boolean; containers: unknown[] };

    expect(result.reachable).toBe(true);
    expect(result.containers).toHaveLength(1);
  });

  it('says a server is unreachable instead of hanging', async () => {
    const never = () => new Promise<never>(() => undefined);

    const result = (await call(
      deps({ containers: never, stacks: never, alerts: never, health: never }),
      'deploy.overview',
      { serverId: 'srv1' },
    )) as { reachable: boolean };

    expect(result.reachable).toBe(false);
  });

  it('refuses a server id that could not be one', async () => {
    await expect(call(deps(), 'deploy.overview', { serverId: '../etc' })).rejects.toBeInstanceOf(
      ManageError,
    );
  });

  it('runs a container action it knows', async () => {
    const containerAction = vi.fn(async () => container as never);

    const result = await call(deps({ containerAction }), 'deploy.containerAction', {
      serverId: 'srv1',
      containerId: 'c1',
      action: 'restart',
    });

    expect(containerAction).toHaveBeenCalledWith('srv1', 'c1', 'restart');
    expect(result).toEqual({ ok: true, message: 'Restarted.' });
  });

  it('refuses a container or app name that could not be one', async () => {
    await expect(
      call(deps(), 'deploy.containerAction', {
        serverId: 'srv1',
        containerId: '../../etc',
        action: 'stop',
      }),
    ).rejects.toBeInstanceOf(ManageError);
    await expect(
      call(deps(), 'deploy.stackAction', { serverId: 'srv1', stack: 'a b', action: 'stop' }),
    ).rejects.toBeInstanceOf(ManageError);
  });

  it('refuses an action the phone does not offer', async () => {
    await expect(
      call(deps(), 'deploy.containerAction', {
        serverId: 'srv1',
        containerId: 'c1',
        action: 'kill',
      }),
    ).rejects.toBeInstanceOf(ManageError);
  });

  it('reports why an action failed in the server’s words', async () => {
    const containerAction = async () => {
      throw new Error('No such container');
    };

    await expect(
      call(deps({ containerAction }), 'deploy.containerAction', {
        serverId: 'srv1',
        containerId: 'c1',
        action: 'stop',
      }),
    ).rejects.toMatchObject({ message: 'No such container' });
  });

  it('reads a limited tail of a container’s logs', async () => {
    const logs = vi.fn(async () => [] as never);

    await call(deps({ logs }), 'deploy.containerLogs', { serverId: 'srv1', containerId: 'c1' });

    expect(logs).toHaveBeenCalledWith('srv1', 'c1', 200);
  });

  it('sends log lines without their timestamps', async () => {
    const lines = await call(deps(), 'deploy.containerLogs', {
      serverId: 'srv1',
      containerId: 'c1',
    });

    expect(lines).toEqual([
      { text: 'started', error: false },
      { text: 'oops', error: true },
    ]);
  });

  it('redeploys what is live, and says when there is nothing to redeploy', async () => {
    const redeploy = vi.fn(async () => ({ id: 'j' }) as never);

    await call(deps({ redeploy }), 'deploy.stackRedeploy', { serverId: 'srv1', stack: 's1' });

    expect(redeploy).toHaveBeenCalledWith('srv1', 's1', 3);
    await expect(
      call(
        deps({ stacks: async () => [{ ...stack, liveRevision: undefined }] as never }),
        'deploy.stackRedeploy',
        { serverId: 'srv1', stack: 's1' },
      ),
    ).rejects.toBeInstanceOf(ManageError);
  });

  it('files anything that changes a server as risky', () => {
    expect(MANAGE_METHODS['deploy.containerAction'].risk).toBe('danger');
    expect(MANAGE_METHODS['deploy.stackAction'].risk).toBe('danger');
    expect(MANAGE_METHODS['deploy.stackRedeploy'].risk).toBe('danger');
  });

  it('runs every method the protocol names for deploy', () => {
    const named = Object.keys(MANAGE_METHODS).filter((name) => name.startsWith('deploy.'));

    expect(Object.keys(deployMethods(deps())).sort()).toEqual(named.sort());
  });
});
