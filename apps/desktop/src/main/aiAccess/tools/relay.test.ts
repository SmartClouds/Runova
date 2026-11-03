import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiTool, ToolContext } from '../registry';

const relay = vi.hoisted(() => ({
  active: true,
  board: vi.fn(async (_projectId: string) => ({})),
  task: vi.fn(async (_projectId: string, _taskId: string) => ({})),
}));

vi.mock('../../relay/board', () => ({
  buildRelayBoard: async (projectId: string) => {
    await relay.board(projectId);
    return {
      projectId,
      docsFolder: 'docs',
      exists: true,
      guidePresent: true,
      tasks: [
        {
          id: 'T001',
          title: 'Set up the database',
          status: 'done',
          epic: 'E01',
          order: 1,
          depends: [],
          estimate: 80_000,
          budget: null,
          specs: ['docs/db.md'],
          file: 'T001-db.md',
          acceptance: { checked: 3, total: 3 },
          issues: [],
          handoff: {
            outcome: 'done',
            tests: 'pass',
            leg: 1,
            updated: '2026-11-01',
            missingSections: [],
            next: 'Nothing left.',
          },
          legCount: 1,
          legPeaks: [70_000],
        },
        {
          id: 'T002',
          title: 'Add the login page',
          status: 'in-progress',
          epic: 'E01',
          order: 2,
          depends: ['T001'],
          estimate: null,
          budget: 120_000,
          specs: [],
          file: 'T002-login.md',
          acceptance: { checked: 1, total: 4 },
          issues: [],
          handoff: null,
          legCount: 2,
          legPeaks: [],
        },
      ],
      order: ['T001', 'T002'],
      cycles: [],
      missing: [],
      issues: [],
      settings: {},
      active: relay.active
        ? {
            id: 'relay-1',
            projectId,
            status: 'running',
            trigger: { kind: 'now' },
            triggerText: 'Started now',
            queue: ['T002'],
            finished: [{ taskId: 'T001', result: 'done' }],
            current: {
              legId: 'leg-9',
              taskId: 'T002',
              legNo: 2,
              phase: 'working',
              tabId: 'tab-1',
              choice: { cliId: 'claude', model: null, effort: null, autoSize: false },
              planFirst: false,
              startedAt: 1_000,
              contextTokens: 50_000,
              peakContextTokens: 60_000,
              budget: 120_000,
              guardAt: 110_000,
              awaiting: null,
            },
            pauseReason: null,
            options: {},
            createdAt: 500,
          }
        : null,
    };
  },
  relayTaskDetail: async (projectId: string, taskId: string) => {
    await relay.task(projectId, taskId);
    if (taskId !== 'T002') return null;
    return {
      task: {
        id: 'T002',
        title: 'Add the login page',
        status: 'in-progress',
        depends: ['T001'],
        body: '## Goal\nA login page.',
        acceptance: { checked: 1, total: 4 },
        file: 'T002-login.md',
      },
      handoff: null,
      handoffText: '# Handoff\nNext: wire the form.',
      legs: [
        {
          legId: 'leg-8',
          relayId: 'relay-1',
          taskId: 'T002',
          legNo: 1,
          cliId: 'claude',
          model: 'opus',
          effort: null,
          tabId: null,
          startedAt: 1_000,
          endedAt: 2_000,
          outcome: 'partial',
          tests: null,
          result: 'continue',
          peakContextTokens: 90_000,
        },
      ],
    };
  },
}));

/** Relay tools: a project's board with the relay running on it, and one task in full. */

const context: ToolContext = { projectId: 'p1', callerKind: 'runova', agent: 'Claude', cwd: null };
let tools: Map<string, AiTool>;

beforeEach(async () => {
  relay.active = true;
  relay.board.mockClear();
  relay.task.mockClear();
  const { relayTools } = await import('./relay');
  tools = new Map(relayTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

describe('relay tools', () => {
  it("shows the project's tasks and the relay running with its current leg", async () => {
    const data = (await run('relay_board')).data as Record<string, unknown>;
    expect(relay.board).toHaveBeenCalledWith('p1');
    expect(data).toMatchObject({
      tasks: [
        { id: 'T001', status: 'done', acceptance: '3/3', handoff: { outcome: 'done' } },
        { id: 'T002', status: 'in-progress', depends: ['T001'], sessions: 2, handoff: null },
      ],
      relay: {
        id: 'relay-1',
        status: 'running',
        queue: ['T002'],
        currentLeg: { taskId: 'T002', legNo: 2, phase: 'working', contextTokens: 50_000 },
      },
    });

    relay.active = false;
    expect(((await run('relay_board')).data as { relay: unknown }).relay).toBeNull();
  });

  it('reads one task with its handoff and the sessions run on it', async () => {
    const data = (await run('relay_task', { taskId: 'T002' })).data;
    expect(data).toMatchObject({
      id: 'T002',
      body: '## Goal\nA login page.',
      handoff: '# Handoff\nNext: wire the form.',
      legs: [{ legNo: 1, cliId: 'claude', result: 'continue', peakContextTokens: 90_000 }],
    });
    await expect(run('relay_task', { taskId: 'T009' })).rejects.toThrow('no task T009');
  });

  it('only reads', () => {
    for (const tool of tools.values()) expect(tool.risk).toBe('read');
  });
});
