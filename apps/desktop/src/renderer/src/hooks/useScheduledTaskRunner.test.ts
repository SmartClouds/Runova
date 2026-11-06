import type { ScheduledTask } from '@runova/core';
import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCliStore } from '@/stores/cliStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderHookWithProviders } from '../../../test/renderer/renderWithProviders';
import { useScheduledTaskRunner } from './useScheduledTaskRunner';

/**
 * Main decides when an automatic prompt is due; the renderer only opens it. It opens as an agent
 * tab in the task's project workspace (not the terminal drawer) and is submitted, and the lists
 * refresh so the card moves to Done.
 */

const toasts = vi.hoisted(() => ({ success: [] as unknown[], error: [] as unknown[] }));
const launch = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn((message: unknown) => toasts.success.push(message)),
    error: vi.fn((message: unknown) => toasts.error.push(message)),
    warning: vi.fn(),
  },
}));

vi.mock('@/lib/workspace/launch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace/launch')>();
  return {
    ...actual,
    launchPromptTab: (...args: Parameters<typeof actual.launchPromptTab>) => {
      launch.calls.push(args);
      return actual.launchPromptTab(...args);
    },
  };
});

const task: ScheduledTask = {
  id: 't1',
  projectId: 'p1',
  rawInput: 'bump deps',
  promptType: '',
  targetAI: 'Claude Code',
  content: 'bump deps',
  runAt: '2026-09-23T02:00:00.000Z',
  status: 'completed',
  createdAt: '2026-09-20T10:00:00.000Z',
  runMode: 'auto',
  cliId: 'claude-code',
};

beforeEach(() => {
  toasts.success = [];
  toasts.error = [];
  launch.calls = [];
  useCliStore.setState({ cliArgs: {}, cliLaunchDefaults: {}, defaultCliId: null });
  useTerminalStore.setState({ sessions: [], activeSessionId: null, isOpen: false });
  useWorkspaceStore.setState({ workspaces: {}, railProjectIds: [], activeProjectId: null });
});

function renderRunner() {
  return renderHookWithProviders(() => useScheduledTaskRunner(), {
    bridge: {
      'projects.list': [{ id: 'p1', name: 'Apollo', folderPath: 'C:\\code\\apollo' }],
    },
  });
}

describe('useScheduledTaskRunner', () => {
  it('opens a due task in its project workspace and submits it', async () => {
    const { bridge, queryClient } = renderRunner();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    bridge.$emit('scheduledTasks.onDue', task);

    await waitFor(() => expect(launch.calls).toHaveLength(1));
    expect(launch.calls[0]?.[1]).toMatchObject({
      cliId: 'claude-code',
      prompt: 'bump deps',
      submit: true,
    });
    const tabs = Object.values(useWorkspaceStore.getState().workspaces.p1?.tabs ?? {});
    expect(tabs).toEqual([
      expect.objectContaining({ kind: 'terminal', cliId: 'claude-code', cwd: 'C:\\code\\apollo' }),
    ]);
    // The terminal drawer stays out of it.
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
    expect(toasts.success).toEqual(['Scheduled prompt started in Claude Code CLI']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['scheduled-tasks'] });
  });

  it('says so when the task project is gone', async () => {
    const { bridge } = renderRunner();

    bridge.$emit('scheduledTasks.onDue', { ...task, projectId: 'gone' });

    await waitFor(() =>
      expect(toasts.error).toEqual(['A scheduled prompt was due, but its project is gone.']),
    );
    expect(launch.calls).toHaveLength(0);
  });

  it('refreshes the lists when main changes tasks on its own', () => {
    const { bridge, queryClient } = renderRunner();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    bridge.$emit('scheduledTasks.onChanged');

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['scheduled-tasks'] });
  });

  it('stops listening when unmounted', () => {
    const { bridge, unmount } = renderRunner();
    expect(bridge.$listenerCount('scheduledTasks.onDue')).toBe(1);

    unmount();

    expect(bridge.$listenerCount('scheduledTasks.onDue')).toBe(0);
    expect(bridge.$listenerCount('scheduledTasks.onChanged')).toBe(0);
  });
});
