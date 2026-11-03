import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiTool, ToolContext } from '../registry';

const docker = vi.hoisted(() => ({
  available: true,
  containers: [
    {
      id: 'abc123def4567890',
      name: 'shop-db',
      image: 'postgres:17',
      state: 'running',
      status: 'Up 2 hours',
      composeProject: 'shop',
      cpuPercent: null,
      memUsedBytes: null,
      memLimitBytes: null,
    },
  ],
  stop: vi.fn(async (_id: string) => ({ ok: true })),
  remove: vi.fn(async (_id: string, _options: unknown) => ({ ok: true })),
}));

vi.mock('../../docker/dockerCli', () => ({
  isDockerAvailable: async () => docker.available,
  listContainers: async () => docker.containers,
  listContainersForProject: async () => docker.containers,
  readContainerLogs: async () => [{ stream: 'stdout', timestamp: '', atUnixMs: 0, text: 'ready' }],
  startContainer: async () => ({ ok: true }),
  stopContainer: docker.stop,
  restartContainer: async () => ({ ok: false, error: 'daemon said no' }),
  removeContainer: docker.remove,
}));

/** The Docker tools: list, read logs, and start, stop, restart or remove a container by name. */

const context: ToolContext = { projectId: null, callerKind: 'external', agent: 'Codex', cwd: null };
let tools: Map<string, AiTool>;

beforeEach(async () => {
  docker.available = true;
  const { dockerTools } = await import('./docker');
  tools = new Map(dockerTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

describe('docker tools', () => {
  it('lists containers and reads logs by name', async () => {
    expect((await run('docker_list')).data).toEqual([
      expect.objectContaining({ id: 'abc123def456', name: 'shop-db', state: 'running' }),
    ]);
    expect((await run('docker_logs', { container: 'SHOP-DB' })).text).toBe('ready');
  });

  it('stops by name or short id, and removes with volumes only when asked', async () => {
    await run('docker_stop', { container: 'abc123' });
    expect(docker.stop).toHaveBeenCalledWith('abc123def4567890');

    const tool = tools.get('docker_remove') as AiTool;
    const preview = await tool.preview(
      tool.input.parse({ container: 'shop-db', removeVolumes: true }),
      context,
    );
    expect(preview).toMatchObject({
      title: 'Remove the container shop-db',
      summary: expect.stringContaining('volumes'),
    });
    await run('docker_remove', { container: 'shop-db' });
    expect(docker.remove).toHaveBeenCalledWith('abc123def4567890', {
      removeVolumes: false,
      removeImage: false,
    });
  });

  it('passes on what Docker said, and says when Docker is not running', async () => {
    await expect(run('docker_restart', { container: 'shop-db' })).rejects.toThrow('daemon said no');
    docker.available = false;
    await expect(run('docker_list')).rejects.toThrow('Docker is not running');
  });
});
