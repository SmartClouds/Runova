import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { WordPressProjectService } from '../../deploy/wordpress/projectService';
import type { AiTool, ToolContext } from '../registry';

/**
 * The WordPress tools: the connected sites, one site's status with its themes and plugins, its
 * deploy history, and deploying a linked project or rolling a deploy back through the section's
 * own service.
 */

const SITE = 'site-1';

const site = {
  id: SITE,
  label: 'Blog',
  siteUrl: 'https://blog.example.com',
  siteName: 'My blog',
  scope: 'write',
  transport: 'https',
  allowPlainHttp: false,
  hasHttpAuth: false,
  pluginVersion: '1.2.0',
  protocol: 1,
  connectedAt: 1_700_000_000_000,
  lastSeenAt: null,
};

const plan = {
  planId: 'plan-1',
  projectId: 'p1',
  siteId: SITE,
  direction: 'deploy',
  changes: [{ path: 'style.css' }, { path: 'functions.php' }],
  conflicts: [] as unknown[],
  leftOut: [],
  warnings: [],
  uploadBytes: 100,
  downloadBytes: 0,
  expiresAt: 0,
};

const wordpress = {
  listSites: vi.fn(async () => [site]),
  siteInfo: vi.fn(async (_site: string) => ({
    siteName: 'My blog',
    homeUrl: 'https://blog.example.com',
    siteUrl: 'https://blog.example.com',
    wpVersion: '6.8',
    phpVersion: '8.3.1',
    pluginVersion: '1.2.0',
    protocol: 1,
    multisite: false,
    activeTheme: { stylesheet: 'blog-child', template: 'twentytwentyfive' },
    https: true,
    fileModsDisabled: false,
    fileEditDisabled: true,
    filesystemMethod: 'direct',
    readOnlyByConstant: false,
    guard: { installed: true, rescueUrl: 'https://blog.example.com/?rescue=SECRETTOKEN' },
    loopback: 'ok',
    connection: { id: 'c1', label: 'Laptop', scope: 'write', createdAt: 1 },
    checkedAt: 1,
  })),
  listItems: vi.fn(async (_site: string) => [
    {
      kind: 'theme',
      slug: 'blog-child',
      name: 'Blog Child',
      version: '1.0',
      isFile: false,
      active: true,
      networkActive: false,
      writable: true,
      protected: false,
    },
    {
      kind: 'plugin',
      slug: 'akismet',
      name: 'Akismet',
      version: '5.3',
      isFile: false,
      active: false,
      networkActive: false,
      writable: true,
      protected: false,
    },
  ]),
  history: vi.fn(async (_site: string) => [
    {
      deployId: 'd1',
      state: 'done',
      label: 'Runova: Blog',
      startedAt: 1_700_000_000,
      finishedAt: 1_700_000_010,
      connectionLabel: 'Laptop',
      puts: 2,
      deletes: 0,
      canRollback: true,
    },
  ]),
  planDeploy: vi.fn(async (_input: unknown) => plan),
  deploy: vi.fn(async (_input: unknown) => ({
    deployId: 'd2',
    state: 'done',
    health: [],
    uploaded: 2,
    deleted: 0,
    durationMs: 900,
  })),
  rollback: vi.fn(async (_input: unknown) => ({
    deployId: 'd1',
    state: 'rolledBack',
    reason: 'requested',
    health: [],
    uploaded: 0,
    deleted: 0,
    durationMs: 400,
  })),
};

const userData = useTempUserData();
const context: ToolContext = { projectId: 'p1', callerKind: 'runova', agent: 'Claude', cwd: null };
let tools: Map<string, AiTool>;

beforeEach(async () => {
  vi.clearAllMocks();
  plan.conflicts = [];
  userData.writeData('projects.json', [
    {
      id: 'p1',
      name: 'Blog theme',
      folderPath: 'C:/code/blog',
      createdAt: '2026-01-01T00:00:00Z',
      wordpress: {
        siteId: SITE,
        items: [{ kind: 'theme', slug: 'blog-child' }],
        linkedAt: '2026-01-01T00:00:00Z',
      },
    },
    { id: 'p2', name: 'Plain', folderPath: 'C:/code/plain', createdAt: '2026-01-01T00:00:00Z' },
  ]);
  // Imported after the modules reset, so the tools see the same store of services.
  const { setLiveDeployServices } = await import('../../deploy/liveServices');
  setLiveDeployServices({ wordpress: wordpress as unknown as WordPressProjectService });
  const { wordpressTools } = await import('./wordpress');
  tools = new Map(wordpressTools.map((tool) => [tool.name, tool]));
});

function tool(name: string): AiTool {
  return tools.get(name) as AiTool;
}

async function run(name: string, args: Record<string, unknown> = {}, on = context) {
  return tool(name).run(tool(name).input.parse(args), on);
}

describe('wordpress tools', () => {
  it('reads freely and marks what changes a live site sensitive', () => {
    for (const one of tools.values()) {
      expect(one.area).toBe('wordpress');
      expect(one.name.startsWith('wordpress_')).toBe(true);
    }
    expect(tool('wordpress_sites').risk).toBe('read');
    expect(tool('wordpress_site_status').risk).toBe('read');
    expect(tool('wordpress_history').risk).toBe('read');
    expect(tool('wordpress_deploy').risk).toBe('sensitive');
    expect(tool('wordpress_rollback').risk).toBe('sensitive');
  });

  it('lists the connected sites', async () => {
    expect((await run('wordpress_sites')).data).toEqual([
      expect.objectContaining({ id: SITE, label: 'Blog', siteUrl: 'https://blog.example.com' }),
    ]);
  });

  it("shows a site's status with its themes and plugins, found by label, without the rescue link", async () => {
    const data = (await run('wordpress_site_status', { site: 'blog' })).data as {
      wordpress: string;
      items: { slug: string; active: boolean }[];
    };
    expect(wordpress.siteInfo).toHaveBeenCalledWith(SITE);
    expect(data.wordpress).toBe('6.8');
    expect(data.items).toEqual([
      expect.objectContaining({ kind: 'theme', slug: 'blog-child', active: true }),
      expect.objectContaining({ kind: 'plugin', slug: 'akismet', active: false }),
    ]);
    expect(JSON.stringify(data)).not.toContain('SECRETTOKEN');
  });

  it('gives the deploy history with readable times', async () => {
    expect((await run('wordpress_history', { site: 'https://blog.example.com/' })).data).toEqual([
      expect.objectContaining({
        deployId: 'd1',
        state: 'done',
        canRollback: true,
        startedAt: new Date(1_700_000_000_000).toISOString(),
      }),
    ]);
  });

  it("deploys the project's linked items, never over conflicts", async () => {
    const shown = await tool('wordpress_deploy').preview(
      tool('wordpress_deploy').input.parse({}),
      context,
    );
    expect(shown.title).toMatch(/Blog theme.*Blog/);
    const result = await run('wordpress_deploy');
    expect(wordpress.planDeploy).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(wordpress.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'plan-1', force: false }),
    );
    expect(result.data).toEqual(expect.objectContaining({ deployId: 'd2', state: 'done' }));

    plan.conflicts = [{ path: 'style.css' }];
    await expect(run('wordpress_deploy')).rejects.toThrow(/changed on the site/);
    expect(wordpress.deploy).toHaveBeenCalledTimes(1);
  });

  it('refuses a project that is not linked to a site', async () => {
    await expect(run('wordpress_deploy', {}, { ...context, projectId: 'p2' })).rejects.toThrow(
      /not linked/,
    );
    expect(wordpress.planDeploy).not.toHaveBeenCalled();
  });

  it('rolls back a deploy from the history', async () => {
    const shown = await tool('wordpress_rollback').preview(
      tool('wordpress_rollback').input.parse({ site: SITE, deployId: 'd1' }),
      context,
    );
    expect(shown.title).toContain('Blog');
    await run('wordpress_rollback', { site: SITE, deployId: 'd1' });
    expect(wordpress.rollback).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE, deployId: 'd1' }),
    );
    await expect(run('wordpress_rollback', { site: SITE, deployId: 'nope' })).rejects.toThrow(
      /nope/,
    );
  });

  it('passes on what the site said without the code tag', async () => {
    wordpress.history.mockRejectedValueOnce(new Error('[wp:unreachable] The site is down.'));
    await expect(run('wordpress_history', { site: SITE })).rejects.toThrow(/^The site is down\.$/);
  });
});
