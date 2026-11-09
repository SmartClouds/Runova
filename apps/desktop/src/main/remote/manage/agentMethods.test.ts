import { describe, expect, it, vi } from 'vitest';
import type { AutoFixSession } from '../../../shared/ciAutoFixTypes';
import { agentMethods, type ManageAgentDeps } from './agentMethods';

const session = {
  id: 's1',
  projectId: 'p1',
  projectName: 'Shop',
  repo: 'a/b',
  workflowId: 7,
  workflowName: 'CI',
  branch: 'main',
  cliId: 'claude-code',
  runArgs: ['--secret-flag'],
  runLabel: null,
  maxAttempts: 3,
  runId: 41,
  runNumber: 41,
  waitFor: null,
  phase: 'fixing',
  blocker: null,
  message: null,
  attempts: [
    {
      n: 1,
      runId: 41,
      runNumber: 41,
      startedAt: 1,
      tabId: 'tab-1',
      baseSha: 'aaa',
      commitSha: 'abcdef1234',
      nextRunId: null,
      nextRunNumber: null,
      outcome: 'fixing',
    },
  ],
  agent: null,
  createdAt: 1,
  updatedAt: 2,
} as unknown as AutoFixSession;

const NOW = 1_800_000_000_000;

function deps(change: Partial<ManageAgentDeps> = {}): ManageAgentDeps {
  return {
    autoFix: {
      list: () => [session, { ...session, id: 's2', projectId: 'other' }],
      enable: vi.fn(async () => ({ ok: true as const, session })),
      stop: vi.fn(async () => session),
      commitNow: vi.fn(async () => session),
      retry: vi.fn(async () => session),
      dismiss: vi.fn(async () => true),
    },
    repoOf: async () => 'a/b',
    failureText: async () => ({ ok: true, text: 'Tests failed in login.' }),
    runPrompt: vi.fn(async () => ({ sessionId: 'tab-9', title: 'Claude Code' })),
    promptOptions: async () => ({
      types: ['Bug Fix'],
      targets: [{ id: 'claude-code', name: 'Claude Code', models: [] }],
      defaultTarget: 'Claude Code',
    }),
    generatePrompt: vi.fn(async () => ({ ok: true, text: 'A good prompt' })),
    cancelPrompt: () => true,
    pickArgs: vi.fn(() => ({ runArgs: ['--model', 'opus'], runLabel: 'Opus' })),
    templates: async () => [
      {
        id: 't1',
        name: 'Bug',
        promptType: 'Bug Fix',
        targetAI: 'Codex',
        content: 'C',
        createdAt: 'x',
      },
    ],
    saveTemplate: vi.fn(async () => ({}) as never),
    deleteTemplate: vi.fn(async () => undefined),
    history: vi.fn(async () => [
      {
        id: 'h1',
        rawInput: 'Fix login',
        promptType: 'Bug Fix',
        targetAI: 'Codex',
        content: 'P',
        source: 'generate' as const,
        tags: [],
        projectId: null,
        createdAt: new Date(NOW - 5000).toISOString(),
      },
    ]),
    scheduled: async () =>
      [
        {
          id: 'a',
          projectId: 'p1',
          rawInput: 'Do it',
          content: 'C',
          targetAI: 'Codex',
          status: 'pending',
          runAt: new Date(NOW + 60000).toISOString(),
        },
        {
          id: 'b',
          projectId: 'p1',
          rawInput: 'Done',
          content: 'C',
          targetAI: 'Codex',
          status: 'completed',
          runAt: new Date(NOW).toISOString(),
        },
        {
          id: 'c',
          projectId: 'other',
          rawInput: 'No',
          content: 'C',
          targetAI: 'Codex',
          status: 'pending',
          runAt: new Date(NOW).toISOString(),
        },
      ] as never,
    schedule: vi.fn(async () => undefined),
    cancelScheduled: vi.fn(async () => true),
    ...change,
  };
}

function call(all: ManageAgentDeps, method: string, params?: unknown) {
  return (agentMethods(all, () => NOW)[method] as (p: unknown) => Promise<unknown>)(params);
}

describe('agents from a phone', () => {
  it('lists only this project and leaves the flags behind', async () => {
    const list = (await call(deps(), 'autofix.list', { projectId: 'p1' })) as Record<
      string,
      unknown
    >[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 's1', phase: 'fixing', agentSession: 'tab-1' });
    expect(JSON.stringify(list[0])).not.toContain('secret-flag');
  });

  it('gives the short form of a commit', async () => {
    const [one] = (await call(deps(), 'autofix.list', { projectId: 'p1' })) as {
      attempts: { commit: string }[];
    }[];
    expect(one?.attempts[0]?.commit).toBe('abcdef1');
  });

  it('finds the repository itself when turning auto-fix on', async () => {
    const all = deps();
    await expect(
      call(all, 'autofix.start', {
        projectId: 'p1',
        workflowId: 7,
        workflowName: 'CI',
        branch: 'main',
        runId: 41,
      }),
    ).resolves.toEqual({ ok: true, message: 'Auto-fix is on.' });
    expect(all.autoFix.enable).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'a/b', runId: 41 }),
    );
  });

  it('says why auto-fix would not start', async () => {
    const all = deps();
    all.autoFix.enable = async () => ({ ok: false, error: 'Another fix is running.' });
    await expect(
      call(all, 'autofix.start', {
        projectId: 'p1',
        workflowId: 7,
        workflowName: 'CI',
        branch: 'main',
      }),
    ).resolves.toEqual({ ok: false, message: 'Another fix is running.' });
  });

  it('refuses a project that is not on GitHub', async () => {
    await expect(
      call(deps({ repoOf: async () => null }), 'autofix.start', {
        projectId: 'p1',
        workflowId: 7,
        workflowName: 'CI',
        branch: 'main',
      }),
    ).rejects.toThrow("isn't on GitHub");
  });

  it('says when a session has gone', async () => {
    const all = deps();
    all.autoFix.stop = async () => null;
    await expect(call(all, 'autofix.stop', { id: 's1' })).resolves.toMatchObject({ ok: false });
  });

  it('builds the fix from the failure and starts an agent', async () => {
    const all = deps();
    await expect(
      call(all, 'agents.fixRun', {
        projectId: 'p1',
        runId: 41,
        workflowName: 'CI',
        branch: 'main',
        runNumber: 41,
      }),
    ).resolves.toEqual({ sessionId: 'tab-9', title: 'Claude Code' });
    expect(all.runPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        prompt: expect.stringContaining('Tests failed in login.'),
      }),
    );
  });

  it('passes on why a failure could not be read', async () => {
    await expect(
      call(deps({ failureText: async () => ({ ok: false, error: 'No log.' }) }), 'agents.fixRun', {
        projectId: 'p1',
        runId: 41,
        workflowName: 'CI',
        branch: 'main',
      }),
    ).rejects.toThrow('No log.');
  });

  it('generates a prompt on the computer', async () => {
    const all = deps();
    await expect(
      call(all, 'prompts.generate', {
        rawInput: 'Fix login',
        promptType: 'Bug Fix',
        targetAI: 'Codex',
        requestId: 'r1',
      }),
    ).resolves.toEqual({ ok: true, text: 'A good prompt', error: null, cancelled: false });
  });

  it('turns down an empty request', async () => {
    await expect(
      call(deps(), 'prompts.generate', {
        rawInput: ' ',
        promptType: 'Bug Fix',
        targetAI: 'Codex',
        requestId: 'r1',
      }),
    ).rejects.toThrow('Describe');
  });

  it('sends a prompt to an agent in the project', async () => {
    const all = deps();
    await call(all, 'agents.runPrompt', { projectId: 'p1', prompt: 'Do it', cliId: 'codex' });
    expect(all.runPrompt).toHaveBeenCalledWith({
      projectId: 'p1',
      prompt: 'Do it',
      cliId: 'codex',
      model: null,
      effort: null,
    });
  });

  it('lets the computer choose the CLI when none is named', async () => {
    const all = deps();
    await call(all, 'agents.runPrompt', { projectId: 'p1', prompt: 'Do it' });
    expect(all.runPrompt).toHaveBeenCalledWith({
      projectId: 'p1',
      prompt: 'Do it',
      cliId: null,
      model: null,
      effort: null,
    });
  });

  it('sends the chosen model and effort on', async () => {
    const all = deps();
    await call(all, 'agents.runPrompt', {
      projectId: 'p1',
      prompt: 'Do it',
      cliId: 'claude-code',
      model: 'opus',
      effort: 'high',
    });
    expect(all.runPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'opus', effort: 'high' }),
    );
  });

  it('refuses an effort nobody offers', async () => {
    await expect(
      call(deps(), 'agents.runPrompt', { projectId: 'p1', prompt: 'Do it', effort: '--yolo' }),
    ).rejects.toThrow('effort');
  });

  it('passes a pick to auto-fix as flags and a label', async () => {
    const all = deps();
    await call(all, 'autofix.start', {
      projectId: 'p1',
      workflowId: 7,
      workflowName: 'CI',
      branch: 'main',
      cliId: 'claude-code',
      model: 'opus',
    });
    expect(all.autoFix.enable).toHaveBeenCalledWith(
      expect.objectContaining({
        cliId: 'claude-code',
        runArgs: ['--model', 'opus'],
        runLabel: 'Opus',
      }),
    );
  });

  it("says so when a model isn't offered", async () => {
    const all = deps({
      pickArgs: () => {
        throw new Error('That model is not offered for this CLI.');
      },
    });
    await expect(
      call(all, 'autofix.start', {
        projectId: 'p1',
        workflowId: 7,
        workflowName: 'CI',
        branch: 'main',
        cliId: 'x',
        model: 'y',
      }),
    ).rejects.toMatchObject({ code: 'failed', message: 'That model is not offered for this CLI.' });
  });

  it('lists templates without when they were made', async () => {
    await expect(call(deps(), 'prompts.templates')).resolves.toEqual([
      { id: 't1', name: 'Bug', promptType: 'Bug Fix', targetAI: 'Codex', content: 'C' },
    ]);
  });

  it('saves and deletes a template', async () => {
    const all = deps();
    await call(all, 'prompts.saveTemplate', {
      name: 'N',
      promptType: 'Bug Fix',
      targetAI: 'Codex',
      content: 'C',
    });
    expect(all.saveTemplate).toHaveBeenCalledWith({
      name: 'N',
      promptType: 'Bug Fix',
      targetAI: 'Codex',
      content: 'C',
    });
    await call(all, 'prompts.deleteTemplate', { id: 't1' });
    expect(all.deleteTemplate).toHaveBeenCalledWith('t1');
  });

  it('gives history with how long ago, capped', async () => {
    const all = deps();
    const [entry] = (await call(all, 'prompts.history', { query: 'login' })) as Record<
      string,
      unknown
    >[];
    expect(entry).toMatchObject({ id: 'h1', content: 'P', agoMs: 5000 });
    expect(all.history).toHaveBeenCalledWith('login', 30);
  });

  it('lists only what is still waiting in this project', async () => {
    await expect(call(deps(), 'prompts.scheduled', { projectId: 'p1' })).resolves.toEqual([
      { id: 'a', summary: 'Do it', targetAI: 'Codex', runsInMs: 60000 },
    ]);
  });

  it('schedules by the computer clock', async () => {
    const all = deps();
    await call(all, 'prompts.schedule', {
      projectId: 'p1',
      rawInput: 'R',
      promptType: 'Bug Fix',
      targetAI: 'Codex',
      content: 'C',
      inMs: 3_600_000,
    });
    expect(all.schedule).toHaveBeenCalledWith({
      projectId: 'p1',
      rawInput: 'R',
      promptType: 'Bug Fix',
      targetAI: 'Codex',
      content: 'C',
      runAt: new Date(NOW + 3_600_000).toISOString(),
    });
  });

  it('refuses to schedule too far ahead', async () => {
    await expect(
      call(deps(), 'prompts.schedule', {
        projectId: 'p1',
        rawInput: 'R',
        promptType: 'Bug Fix',
        targetAI: 'Codex',
        content: 'C',
        inMs: 8 * 86_400_000,
      }),
    ).rejects.toThrow('too far');
  });

  it('refuses a prompt past what a phone could mean to send', async () => {
    await expect(
      call(deps(), 'agents.runPrompt', { projectId: 'p1', prompt: 'x'.repeat(70_000) }),
    ).rejects.toThrow('no prompt');
  });
});
