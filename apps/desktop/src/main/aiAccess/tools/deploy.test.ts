import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeployDocker } from '../../deploy/docker';
import type { DeployService } from '../../deploy/service';
import type { DeploySites } from '../../deploy/sites/deploySites';
import type { DeployStacks } from '../../deploy/stacks/service';
import type { AiTool, ToolContext } from '../registry';

/**
 * The Deploy tools: servers and what runs on them as the Deploy page shows it, a container's
 * recent logs, and deploying or restarting an app through the page's own services.
 */

const APP = '11111111-2222-3333-4444-555555555555';

const servers = [
  {
    id: 'srv-1',
    nickname: 'Prod',
    host: '203.0.113.5',
    port: 22,
    username: 'deploy',
    core: {
      version: '1.4.0',
      release: '/opt/runova/1.4.0',
      transport: 'streamlocal',
      installedAt: 0,
      os: 'Ubuntu 24.04',
      architecture: 'x86_64',
    },
    enrolled: true,
  },
  {
    id: 'srv-2',
    nickname: 'Bare',
    host: '203.0.113.6',
    port: 22,
    username: 'root',
    core: null,
    enrolled: false,
  },
];

const stack = {
  id: APP,
  name: 'shop',
  status: 'running',
  createdAtUnixMs: 1,
  updatedAtUnixMs: 2,
  revisionCount: 3,
  liveRevision: 2,
  runningContainers: 1,
  containers: 1,
  source: { projectName: 'Shop', composePath: 'compose.yaml' },
};

const container = {
  id: 'f00dcafe1234567890',
  name: 'shop-web-1',
  image: 'shop:latest',
  imageId: 'sha256:1',
  state: 'running',
  status: 'Up 1 hour',
  health: 'healthy',
  createdAtUnixMs: 1,
  ports: [],
  composeProject: 'shop',
  composeService: 'web',
};

function revision(number: number, extra: Record<string, unknown> = {}) {
  return {
    stackId: APP,
    number,
    state: number === 2 ? 'live' : 'ready',
    createdAtUnixMs: number,
    composeSha256: 'x',
    envKeys: ['SECRET_KEY'],
    services: ['web'],
    proxiedServices: [],
    hasBuildContext: false,
    steps: [],
    findings: [],
    acknowledgedRisks: [],
    unacknowledgedRisks: [],
    bindings: [],
    ...extra,
  };
}

const fakes = vi.hoisted(() => ({
  deployJob: { id: 'job-1', kind: 'stackDeploy', title: 'Deploy shop', state: 'queued' },
}));

const deploy = { listServers: vi.fn(async () => servers) };
const stacks = {
  list: vi.fn(async (_server: string) => [stack]),
  get: vi.fn(async (_server: string, _stack: string) => ({
    stack,
    revisions: [revision(1), revision(2), revision(3, { unacknowledgedRisks: ['privileged'] })],
    services: [{ name: 'web', containers: [container], ports: [] }],
  })),
  deploy: vi.fn(async (_server: string, _stack: string, _revision: number) => fakes.deployJob),
  action: vi.fn(async (_server: string, _stack: string, _action: string) => ({
    ...fakes.deployJob,
    title: 'Restart shop',
  })),
};
const sites = {
  sites: vi.fn(async (_server: string) => [
    {
      settings: {
        id: 'shop',
        domains: ['shop.example.com'],
        upstream: { kind: 'service', service: 'web', port: 80, verifyCertificate: false },
        redirectToHttps: true,
        basicAuth: { users: [{ name: 'admin', passwordHash: '$apr1$secret' }] },
      },
      applied: true,
      createdAtUnixMs: 1,
      updatedAtUnixMs: 2,
      certificate: { state: 'valid', notAfterUnixMs: 1_900_000_000_000, issuer: 'R3' },
    },
  ]),
};
const docker = {
  listContainers: vi.fn(async (_server: string) => ({
    groups: [{ project: 'shop', containers: [container] }],
  })),
  logTail: vi.fn(async (_input: unknown) => [
    { stream: 'stdout', timestamp: '', atUnixMs: 0, text: 'listening on 80' },
    { stream: 'stderr', timestamp: '', atUnixMs: 0, text: 'warn: slow' },
  ]),
};

const context: ToolContext = { projectId: null, callerKind: 'runova', agent: 'Claude', cwd: null };
let tools: Map<string, AiTool>;

beforeEach(async () => {
  vi.clearAllMocks();
  // Imported after the modules reset, so the tools see the same store of services.
  const { setLiveDeployServices } = await import('../../deploy/liveServices');
  setLiveDeployServices({
    deploy: deploy as unknown as DeployService,
    stacks: stacks as unknown as DeployStacks,
    sites: sites as unknown as DeploySites,
    docker: docker as unknown as DeployDocker,
  });
  const { deployTools } = await import('./deploy');
  tools = new Map(deployTools.map((tool) => [tool.name, tool]));
});

function tool(name: string): AiTool {
  return tools.get(name) as AiTool;
}

async function run(name: string, args: Record<string, unknown> = {}) {
  return tool(name).run(tool(name).input.parse(args), context);
}

describe('deploy tools', () => {
  it('keeps the word deploy for the sensitive tools, and all of them in the deploy area', () => {
    for (const one of tools.values()) {
      expect(one.area).toBe('deploy');
      if (/(^|_)deploy(_|$)/.test(one.name)) expect(one.risk, one.name).toBe('sensitive');
    }
    expect(tool('deploy_app').risk).toBe('sensitive');
    expect(tool('hosting_app_restart').risk).toBe('sensitive');
    expect(tool('hosting_servers').risk).toBe('read');
  });

  it('lists the servers without any login detail', async () => {
    const data = (await run('hosting_servers')).data;
    expect(data).toEqual([
      expect.objectContaining({ id: 'srv-1', name: 'Prod', host: '203.0.113.5', core: '1.4.0' }),
      expect.objectContaining({ id: 'srv-2', name: 'Bare', core: null }),
    ]);
    expect(JSON.stringify(data)).not.toMatch(/username|password|deploy"/);
  });

  it('lists the apps on a server found by name, and one app in detail', async () => {
    expect((await run('hosting_apps', { server: 'prod' })).data).toEqual([
      expect.objectContaining({ id: APP, name: 'shop', status: 'running', liveRevision: 2 }),
    ]);
    expect(stacks.list).toHaveBeenCalledWith('srv-1');
    const detail = (await run('hosting_apps', { server: 'srv-1', app: 'shop' })).data as {
      services: { containers: { name: string }[] }[];
      revisions: { number: number }[];
    };
    expect(detail.services[0].containers[0].name).toBe('shop-web-1');
    expect(detail.revisions.map((one) => one.number)).toEqual([1, 2, 3]);
    expect(JSON.stringify(detail)).not.toContain('SECRET_KEY');
  });

  it('refuses a server without Runova on it', async () => {
    await expect(run('hosting_apps', { server: 'Bare' })).rejects.toThrow(/Bare/);
    expect(stacks.list).not.toHaveBeenCalled();
  });

  it('lists the websites without their sign-in hashes', async () => {
    const data = (await run('hosting_websites', { server: 'Prod' })).data;
    expect(data).toEqual([
      expect.objectContaining({
        id: 'shop',
        domains: ['shop.example.com'],
        applied: true,
        certificate: expect.objectContaining({ state: 'valid' }),
      }),
    ]);
    expect(JSON.stringify(data)).not.toContain('secret');
  });

  it("reads a container's recent log lines by name", async () => {
    const text = (await run('hosting_container_logs', { server: 'Prod', container: 'shop-web-1' }))
      .text;
    expect(docker.logTail).toHaveBeenCalledWith({
      serverId: 'srv-1',
      containerId: 'f00dcafe1234567890',
      tail: 200,
    });
    expect(text).toBe('listening on 80\nwarn: slow');
  });

  it('deploys the live revision again by default, and a named one when asked', async () => {
    const shown = await tool('deploy_app').preview(
      tool('deploy_app').input.parse({ server: 'Prod', app: 'shop' }),
      context,
    );
    expect(shown.title).toMatch(/shop.*Prod/);
    expect((await run('deploy_app', { server: 'Prod', app: 'shop' })).data).toEqual(
      expect.objectContaining({ id: 'job-1' }),
    );
    expect(stacks.deploy).toHaveBeenCalledWith('srv-1', APP, 2);
    await run('deploy_app', { server: 'Prod', app: APP, revision: 1 });
    expect(stacks.deploy).toHaveBeenLastCalledWith('srv-1', APP, 1);
  });

  it('leaves a revision with findings nobody accepted to the Deploy page', async () => {
    await expect(run('deploy_app', { server: 'Prod', app: 'shop', revision: 3 })).rejects.toThrow(
      /accept/i,
    );
    await expect(run('deploy_app', { server: 'Prod', app: 'shop', revision: 9 })).rejects.toThrow(
      /revision 9/,
    );
    expect(stacks.deploy).not.toHaveBeenCalled();
  });

  it('restarts an app', async () => {
    await run('hosting_app_restart', { server: 'Prod', app: 'shop' });
    expect(stacks.action).toHaveBeenCalledWith('srv-1', APP, 'restart');
  });

  it('passes on what the core said without the code tag', async () => {
    stacks.list.mockRejectedValueOnce(new Error('[core:forbidden] Your role cannot do that.'));
    await expect(run('hosting_apps', { server: 'Prod' })).rejects.toThrow(
      /^Your role cannot do that\.$/,
    );
  });
});
