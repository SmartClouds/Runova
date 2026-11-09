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
      targets: [{ id: 'claude-code', name: 'Claude Code' }],
      defaultTarget: 'Claude Code',
    }),
    generatePrompt: vi.fn(async () => ({ ok: true, text: 'A good prompt' })),
    cancelPrompt: () => true,
    ...change,
  };
}

function call(all: ManageAgentDeps, method: string, params?: unknown) {
  return (agentMethods(all)[method] as (p: unknown) => Promise<unknown>)(params);
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
    });
  });

  it('lets the computer choose the CLI when none is named', async () => {
    const all = deps();
    await call(all, 'agents.runPrompt', { projectId: 'p1', prompt: 'Do it' });
    expect(all.runPrompt).toHaveBeenCalledWith({ projectId: 'p1', prompt: 'Do it', cliId: null });
  });

  it('refuses a prompt past what a phone could mean to send', async () => {
    await expect(
      call(deps(), 'agents.runPrompt', { projectId: 'p1', prompt: 'x'.repeat(70_000) }),
    ).rejects.toThrow('no prompt');
  });
});
