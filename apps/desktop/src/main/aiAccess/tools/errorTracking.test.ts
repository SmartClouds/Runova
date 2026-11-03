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

const service = vi.hoisted(() => ({
  links: [] as unknown[],
  listIssues: vi.fn(async (_query: unknown) => ({})),
  getIssue: vi.fn(async (_ref: unknown) => ({})),
  setIssueStatus: vi.fn(async (_change: unknown) => ({})),
  listConnections: vi.fn(async () => [] as unknown[]),
}));

vi.mock('../../errorTracking/service', () => ({
  getErrorTrackingService: () => ({
    listIssues: service.listIssues,
    getIssue: service.getIssue,
    setIssueStatus: service.setIssueStatus,
    listConnections: service.listConnections,
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
        locked: false,
        createdAt: 0,
        checkedAt: null,
        problem: null,
        tokenEnvelope: 'sealed-token',
      },
    ]);
    const data = (await run('errors_connections')).data as { connections: object[] };
    expect(data).toMatchObject({
      connections: [{ id: 'c1', orgSlug: 'me', canWrite: false }],
      links: [{ projectId: 'p1', remoteSlug: 'shop-web' }],
    });
    expect(JSON.stringify(data)).not.toContain('sealed-token');
  });
});
