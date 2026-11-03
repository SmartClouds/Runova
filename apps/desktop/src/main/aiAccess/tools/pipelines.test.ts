import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { AiTool, ToolContext } from '../registry';

const gh = vi.hoisted(() => ({
  dispatch: vi.fn(async (_input: unknown) => ({ ok: true as const })),
  cancel: vi.fn(async (_input: unknown) => ({
    ok: false as const,
    error: 'Run already finished.',
  })),
}));

vi.mock('../../pipelines/githubActions', () => ({
  fetchProjectPipelineStatus: async () => ({
    projectId: 'p1',
    cliAvailable: true,
    authenticated: true,
    github: { owner: 'me', repo: 'shop' },
    workflows: [{ id: 7, name: 'CI' }],
    runsByWorkflowId: {
      7: {
        id: 99,
        displayTitle: 'Fix login',
        headBranch: 'main',
        status: 'completed',
        conclusion: 'failure',
        htmlUrl: 'https://github.com/me/shop/actions/runs/99',
        createdAt: '2026-11-01T00:00:00Z',
      },
    },
  }),
  fetchRunFailureText: async () => ({ ok: true, text: 'npm test failed: 2 tests' }),
  dispatchWorkflow: gh.dispatch,
  cancelWorkflowRun: gh.cancel,
}));

vi.mock('../../usage', () => ({
  getAllUsage: async () => [
    {
      providerId: 'claude-code',
      status: 'ok',
      series: [1, 2, 3],
      currency: 'USD',
      today: { tokens: 10 },
    },
  ],
}));

/** Pipeline and usage tools: read the latest runs and why one failed, start or cancel a run. */

const userData = useTempUserData();
const context: ToolContext = {
  projectId: 'p1',
  callerKind: 'runova',
  agent: 'Claude Code',
  cwd: null,
};
let tools: Map<string, AiTool>;

beforeEach(async () => {
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: 'C:/code/shop', createdAt: '2026-01-01T00:00:00Z' },
  ]);
  const { pipelineTools } = await import('./pipelines');
  tools = new Map(pipelineTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

describe('pipeline tools', () => {
  it('shows each workflow with its latest run, and why a run failed', async () => {
    expect((await run('pipelines_status')).data).toEqual({
      repo: 'me/shop',
      workflows: [
        expect.objectContaining({
          id: 7,
          name: 'CI',
          latestRun: expect.objectContaining({ id: 99, conclusion: 'failure' }),
        }),
      ],
    });
    expect((await run('pipelines_failure_log', { runId: 99 })).text).toContain('npm test failed');
  });

  it('starts a workflow on the project repository, and passes on what GitHub refused', async () => {
    await run('pipelines_dispatch', { workflowId: 7, ref: 'main', inputs: { env: 'staging' } });
    expect(gh.dispatch).toHaveBeenCalledWith({
      repo: 'me/shop',
      workflowId: 7,
      ref: 'main',
      inputs: { env: 'staging' },
    });
    await expect(run('pipelines_cancel_run', { runId: 99 })).rejects.toThrow(
      'Run already finished.',
    );
  });

  it('gives the usage totals without the chart series', async () => {
    const [usage] = (await run('usage_summary')).data as Record<string, unknown>[];
    expect(usage).toMatchObject({ providerId: 'claude-code', today: { tokens: 10 } });
    expect(usage).not.toHaveProperty('series');
  });
});
