import type { Project } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCliStore } from '@/stores/cliStore';
import { resolveRunCliId, runPromptInWorkspace } from './runScheduledPrompt';

/**
 * A scheduled prompt runs in an agent tab of its project's workspace, never in the terminal
 * drawer, in the CLI it was scheduled for with its model and effort. Run by hand it is only
 * pasted, so the user starts it; a scheduled run that came due on its own is submitted too.
 */

const launchPromptTab = vi.hoisted(() => vi.fn((..._args: unknown[]): string | null => 'tab-1'));

vi.mock('@/lib/workspace/launch', () => ({ launchPromptTab }));

const project = { id: 'p1', name: 'Apollo', folderPath: 'C:\\code\\apollo' } as Project;

beforeEach(() => {
  launchPromptTab.mockClear();
  useCliStore.setState({ cliArgs: {}, cliLaunchDefaults: {}, defaultCliId: null });
});

function run(overrides: Partial<Parameters<typeof runPromptInWorkspace>[1]> = {}) {
  return runPromptInWorkspace(project, {
    content: 'fix the login bug',
    targetAI: 'Claude Code',
    submit: false,
    ...overrides,
  });
}

describe('resolveRunCliId', () => {
  it('prefers the task CLI, then the app default, then the target AI', () => {
    expect(resolveRunCliId('codex-cli', 'Claude Code')).toBe('codex-cli');
    useCliStore.setState({ defaultCliId: 'codex-cli' });
    expect(resolveRunCliId(undefined, 'Claude Code')).toBe('codex-cli');
    useCliStore.setState({ defaultCliId: null });
    expect(resolveRunCliId(undefined, 'Claude Code')).toBe('claude-code');
  });

  it('skips a CLI id that no longer exists', () => {
    expect(resolveRunCliId('gone-cli', 'Claude Code')).toBe('claude-code');
  });
});

describe('runPromptInWorkspace', () => {
  it('opens the CLI in the workspace with its model and effort, leaving the prompt unsent', () => {
    const started = run({ cliId: 'claude-code', model: 'opus', effort: 'high' });

    expect(started).toEqual({ cliName: 'Claude Code CLI', tabId: 'tab-1' });
    expect(launchPromptTab).toHaveBeenCalledWith(project, {
      cliId: 'claude-code',
      prompt: 'fix the login bug',
      runArgs: ['--model', 'opus', '--effort', 'high'],
      runLabel: 'Scheduled prompt',
      submit: false,
    });
  });

  it('asks for the Enter when the run should start on its own', () => {
    run({ cliId: 'claude-code', submit: true });

    expect(launchPromptTab.mock.calls[0]?.[1]).toMatchObject({ submit: true });
  });

  it('drops model and effort when it falls back to a different CLI', () => {
    useCliStore.setState({ defaultCliId: 'codex-cli' });

    run({ model: 'opus', effort: 'high' });

    expect(launchPromptTab.mock.calls[0]?.[1]).toMatchObject({ cliId: 'codex-cli', runArgs: [] });
  });

  it('reports nothing started when the tab could not open', () => {
    launchPromptTab.mockReturnValueOnce(null);

    expect(run({ cliId: 'claude-code' })).toBeNull();
  });
});
