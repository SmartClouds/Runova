import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorIssueSummary } from '../../../shared/errorTrackingTypes';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { AiTool, ToolContext } from '../registry';

const issue: ErrorIssueSummary = {
  id: '4001',
  shortId: 'SHOP-3F',
  title: 'TypeError: cart is undefined',
  culprit: 'src/cart.ts in addItem',
  level: 'error',
  status: 'unresolved',
  count: 12,
  userCount: 3,
  firstSeen: '2026-11-01T10:00:00Z',
  lastSeen: '2026-11-02T10:00:00Z',
  permalink: 'https://sentry.io/organizations/me/issues/4001/',
  remoteProjectId: '77',
  remoteProjectSlug: 'shop-web',
  trend: [1, 4, 7],
  connectionId: 'c1',
  projectId: 'p1',
  isNew: false,
};

const DSN = 'https://abc@o1.ingest.sentry.io/203';

const service = vi.hoisted(() => ({
  links: [] as unknown[],
  listIssues: vi.fn(async (_query: unknown) => ({})),
  getIssue: vi.fn(async (_ref: unknown) => ({})),
  setIssueStatus: vi.fn(async (_change: unknown) => ({})),
  listConnections: vi.fn(async () => [] as unknown[]),
  teams: vi.fn(async (_connectionId: string) => [] as unknown[]),
  createProject: vi.fn(async (_input: unknown) => ({}) as unknown),
  projectKeys: vi.fn(async (_ref: unknown) => ({}) as unknown),
}));

vi.mock('../../errorTracking/service', () => ({
  getErrorTrackingService: () => ({
    listIssues: service.listIssues,
    getIssue: service.getIssue,
    setIssueStatus: service.setIssueStatus,
    listConnections: service.listConnections,
    teams: service.teams,
    createProject: service.createProject,
    projectKeys: service.projectKeys,
    listLinks: async (filter: { projectId?: string } = {}) =>
      service.links.filter(
        (one) => !filter.projectId || (one as { projectId: string }).projectId === filter.projectId,
      ),
  }),
}));

/** Error tracking tools: the issues the Errors tab shows, one issue in full, resolving and ignoring. */

useTempUserData();
const inProject: ToolContext = {
  projectId: 'p1',
  callerKind: 'runova',
  agent: 'Claude Code',
  cwd: null,
};
const anywhere: ToolContext = { ...inProject, projectId: null };
let tools: Map<string, AiTool>;

beforeEach(async () => {
  service.links = [
    {
      projectId: 'p1',
      connectionId: 'c1',
      remoteProjectId: '77',
      remoteSlug: 'shop-web',
      remoteName: 'Shop web',
    },
  ];
  service.listIssues.mockReset();
  service.listIssues.mockResolvedValue({
    issues: [issue],
    nextCursor: 'next-page',
    failures: [],
    fetchedAt: 0,
  });
  service.getIssue.mockReset();
  service.getIssue.mockResolvedValue({ issue, event: null, canWrite: true });
  service.setIssueStatus.mockReset();
  service.setIssueStatus.mockResolvedValue({ ...issue, status: 'resolved' });
  service.listConnections.mockReset();
  service.listConnections.mockResolvedValue([]);
  service.teams.mockReset();
  service.teams.mockResolvedValue([
    { id: '7', slug: 'platform', name: 'Platform', isMember: true },
  ]);
  service.createProject.mockReset();
  service.createProject.mockResolvedValue({
    connectionId: 'c1',
    project: { id: '203', slug: 'checkout', name: 'Checkout', platform: 'node' },
    dsn: DSN,
    keys: [{ id: 'k', name: 'Default', dsn: DSN, isActive: true }],
    link: {
      projectId: 'p1',
      connectionId: 'c1',
      remoteProjectId: '203',
      remoteSlug: 'checkout',
      remoteName: 'Checkout',
    },
    keysUrl: 'https://sentry.io/settings/me/projects/checkout/keys/',
  });
  service.projectKeys.mockReset();
  service.projectKeys.mockResolvedValue({
    keys: [{ id: 'k', name: 'Default', dsn: DSN, isActive: true }],
    keysUrl: 'https://sentry.io/settings/me/projects/shop-web/keys/',
  });
  const { errorTrackingTools } = await import('./errorTracking');
  tools = new Map(errorTrackingTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}, context = inProject) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

describe('error tracking tools', () => {
  it("lists the project's unresolved issues the way the Errors tab opens", async () => {
    const data = (await run('errors_issues')).data as Record<string, unknown>;
    expect(service.listIssues).toHaveBeenCalledWith({
      projectId: 'p1',
      status: 'unresolved',
      period: '14d',
      sort: 'lastSeen',
    });
    expect(data).toMatchObject({
      nextCursor: 'next-page',
      issues: [{ connectionId: 'c1', issueId: '4001', shortId: 'SHOP-3F', count: 12 }],
    });
    expect((data.issues as object[])[0]).not.toHaveProperty('trend');

    await run('errors_issues', { status: 'all', search: 'cart', cursor: 'next-page' }, anywhere);
    expect(service.listIssues).toHaveBeenLastCalledWith({
      status: 'all',
      period: '14d',
      sort: 'lastSeen',
      search: 'cart',
      cursor: 'next-page',
    });
  });

  it('says so when the project has no linked error tracking project', async () => {
    service.links = [];
    expect((await run('errors_issues')).text).toMatch(/no error tracking project linked/i);
    expect(service.listIssues).not.toHaveBeenCalled();
  });

  it('reads one issue with its latest event, and refuses an issue id that is not one', async () => {
    const data = (await run('errors_issue', { connectionId: 'c1', issueId: '4001' })).data;
    expect(service.getIssue).toHaveBeenCalledWith({ connectionId: 'c1', issueId: '4001' });
    expect(data).toMatchObject({ issue: { shortId: 'SHOP-3F' }, event: null, canWrite: true });
    const tool = tools.get('errors_issue') as AiTool;
    expect(() => tool.input.parse({ connectionId: 'c1', issueId: '../../admin' })).toThrow();
  });

  it('resolves and ignores an issue through the service', async () => {
    const result = await run('errors_set_status', {
      connectionId: 'c1',
      issueId: '4001',
      status: 'resolved',
    });
    expect(service.setIssueStatus).toHaveBeenCalledWith({
      connectionId: 'c1',
      issueId: '4001',
      status: 'resolved',
    });
    expect(result.text).toContain('SHOP-3F');
    const tool = tools.get('errors_set_status') as AiTool;
    const shown = await tool.preview(
      tool.input.parse({
        connectionId: 'c1',
        issueId: '4001',
        status: 'ignored',
        ignoreMinutes: 60,
      }),
      inProject,
    );
    expect(shown.title).toBe('Ignore SHOP-3F');
  });

  it('lists connections and links without anything secret', async () => {
    service.listConnections.mockResolvedValue([
      {
        id: 'c1',
        provider: 'sentry',
        label: 'Me',
        host: 'https://sentry.io',
        apiBase: 'https://us.sentry.io',
        orgSlug: 'me',
        orgName: 'Me',
        scopes: ['event:read'],
        canWrite: false,
        canCreateProjects: false,
        locked: false,
        createdAt: 0,
        checkedAt: null,
        problem: null,
        tokenEnvelope: 'sealed-token',
      },
    ]);
    const data = (await run('errors_connections')).data as { connections: object[] };
    expect(data).toMatchObject({
      connections: [{ id: 'c1', orgSlug: 'me', canWrite: false, canCreateProjects: false }],
      links: [{ projectId: 'p1', remoteSlug: 'shop-web' }],
    });
    expect(JSON.stringify(data)).not.toContain('sealed-token');
  });

  it('creates a Sentry project linked to the project, and hands back its DSN and setup', async () => {
    service.listConnections.mockResolvedValue([{ id: 'c1', label: 'Me', orgSlug: 'me' }]);
    const tool = tools.get('errors_create_project') as AiTool;
    expect(tool.risk).toBe('write');
    const args = tool.input.parse({ connectionId: 'c1', name: 'Checkout', platform: 'node' });
    const shown = await tool.preview(args, inProject);
    expect(shown).toMatchObject({
      title: 'Create the Sentry project "Checkout"',
      fields: expect.arrayContaining([
        { label: 'Organization', value: 'Me' },
        { label: 'Platform', value: 'Node.js' },
      ]),
    });
    const data = (await tool.run(args, inProject)).data as Record<string, unknown>;
    expect(service.createProject).toHaveBeenCalledWith({
      connectionId: 'c1',
      teamSlug: 'platform',
      name: 'Checkout',
      platform: 'node',
      linkProjectId: 'p1',
    });
    expect(data).toMatchObject({
      project: { slug: 'checkout' },
      dsn: DSN,
      linkedTo: 'p1',
      setup: { install: 'npm install --save @sentry/node', env: `SENTRY_DSN=${DSN}` },
    });
    expect((data.setup as { code: string }).code).toContain(DSN);
  });

  it('links nothing when asked not to, or when there is no project', async () => {
    await run('errors_create_project', { connectionId: 'c1', name: 'A', link: false });
    expect(service.createProject).toHaveBeenLastCalledWith(
      expect.objectContaining({ linkProjectId: null }),
    );
    await run('errors_create_project', { connectionId: 'c1', name: 'B' }, anywhere);
    expect(service.createProject).toHaveBeenLastCalledWith(
      expect.objectContaining({ linkProjectId: null }),
    );
  });

  it('asks for a team when the organization has several, and refuses a platform it does not know', async () => {
    service.teams.mockResolvedValue([
      { id: '7', slug: 'platform', name: 'Platform', isMember: true },
      { id: '8', slug: 'web', name: 'Web', isMember: false },
    ]);
    await expect(run('errors_create_project', { connectionId: 'c1', name: 'A' })).rejects.toThrow(
      'Pass teamSlug, one of: platform, web.',
    );
    await run('errors_create_project', { connectionId: 'c1', name: 'A', teamSlug: 'web' });
    expect(service.createProject).toHaveBeenLastCalledWith(
      expect.objectContaining({ teamSlug: 'web' }),
    );
    service.teams.mockResolvedValue([]);
    await expect(run('errors_create_project', { connectionId: 'c1', name: 'A' })).rejects.toThrow(
      /has no team/,
    );
    const tool = tools.get('errors_create_project') as AiTool;
    expect(() => tool.input.parse({ connectionId: 'c1', name: 'A', platform: 'cobol' })).toThrow();
  });

  it("reads a project's DSN with a setup snippet", async () => {
    const tool = tools.get('errors_project_keys') as AiTool;
    expect(tool.risk).toBe('read');
    const data = (await run('errors_project_keys', { connectionId: 'c1', remoteSlug: 'shop-web' }))
      .data as Record<string, unknown>;
    expect(service.projectKeys).toHaveBeenCalledWith({
      connectionId: 'c1',
      remoteSlug: 'shop-web',
    });
    expect(data).toMatchObject({
      keys: [{ name: 'Default', dsn: DSN, isActive: true }],
      keysUrl: 'https://sentry.io/settings/me/projects/shop-web/keys/',
    });
  });
});
