import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionEntry, AutoContinuePendingMap } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { invoke, loadIpc, useTempUserData } from '../../test/main/ipcHarness';

/**
 * The auto-continue half of the agents IPC: the renderer's tab list turns watching on and off,
 * main reports what it has scheduled, and a scheduled continue can be dropped.
 *
 * Terminals are kept in this process (no background host) and node-pty is stubbed, since
 * syncing a tab list also attaches to its sessions.
 */

vi.mock('../ptyHost/hostLauncher', () => ({ connectToHost: async () => null }));

const history = vi.hoisted(() => ({ listAgentHistory: vi.fn(async () => []) }));
vi.mock('../agents/sessionHistory', () => history);

const sessionUsage = vi.hoisted(() => ({
  readSessionUsage: vi.fn(async () => ({ status: 'unavailable' })),
}));
vi.mock('../agents/sessionUsage', () => sessionUsage);

const projectUsage = vi.hoisted(() => ({
  readProjectUsage: vi.fn(async () => ({ status: 'unavailable' })),
}));
vi.mock('../agents/projectUsage', () => projectUsage);

const contextUsage = vi.hoisted(() => ({
  readSessionContextUsage: vi.fn(async (_id: string): Promise<unknown> => null),
}));
vi.mock('../agents/contextUsage', () => contextUsage);

vi.mock('../ptyHost/sessionManager', () => ({
  PtySessionManager: class {
    createOrAttach(): unknown {
      return { isNew: true, snapshot: null };
    }
    write(): void {
      return undefined;
    }
    resize(): void {
      return undefined;
    }
    kill(): void {
      return undefined;
    }
    killAll(): void {
      return undefined;
    }
    list(): unknown[] {
      return [];
    }
  },
}));

const userData = useTempUserData();

let terminal: typeof import('./terminal');

beforeEach(async () => {
  terminal = await import('./terminal');
  await loadIpc(
    () => import('./agents'),
    (module) => module.registerAgentHandlers(),
  );
});

function tab(sessionId: string, autoContinue?: unknown): AgentSessionEntry {
  return {
    sessionId,
    projectId: 'p1',
    cliId: 'claude-code',
    title: 'Claude Code',
    autoContinue: autoContinue as AgentSessionEntry['autoContinue'],
  };
}

const NETWORK_ERROR = 'API Error: Connection error.';

describe('agents:sync and auto-continue', () => {
  it('starts watching a tab that turned auto-continue on', async () => {
    await invoke(IPC.agents.sync, [tab('watched', { afterNetworkError: true })]);
    terminal.autoContinue.output('watched', NETWORK_ERROR);

    const pending = await invoke<AutoContinuePendingMap>(IPC.agents.autoContinuePending);
    expect(pending.watched).toMatchObject({ kind: 'network', attempt: 1 });
  });

  it('stops watching when the tab turns it off again', async () => {
    await invoke(IPC.agents.sync, [tab('toggled', { afterNetworkError: true })]);
    terminal.autoContinue.output('toggled', NETWORK_ERROR);
    await invoke(IPC.agents.sync, [tab('toggled', { afterNetworkError: false })]);

    expect(await invoke(IPC.agents.autoContinuePending)).toEqual({});
  });

  it('turns away a tab whose options are not the shape the renderer sends', async () => {
    await invoke(IPC.agents.sync, [tab('string', 'yes'), tab('numbers', { afterNetworkError: 1 })]);
    terminal.autoContinue.output('string', NETWORK_ERROR);
    terminal.autoContinue.output('numbers', NETWORK_ERROR);

    expect(await invoke(IPC.agents.autoContinuePending)).toEqual({});
  });

  it('drops a scheduled continue on request, and ignores a bad id', async () => {
    await invoke(IPC.agents.sync, [tab('cancelled', { afterNetworkError: true })]);
    terminal.autoContinue.output('cancelled', NETWORK_ERROR);

    await invoke(IPC.agents.cancelAutoContinue, 42);
    expect(await invoke<AutoContinuePendingMap>(IPC.agents.autoContinuePending)).toHaveProperty(
      'cancelled',
    );

    await invoke(IPC.agents.cancelAutoContinue, 'cancelled');
    expect(await invoke(IPC.agents.autoContinuePending)).toEqual({});
  });
});

describe('agent history', () => {
  it('reads the conversations started in a worktree from its own folder', async () => {
    userData.writeData('projects.json', [
      { id: 'p1', name: 'App', folderPath: 'C:/code/app', createdAt: '2026-01-01' },
    ]);
    userData.writeData('worktrees.json', [
      {
        id: 'wt-1',
        projectId: 'p1',
        path: 'C:/code/app.worktrees/feat',
        branch: 'feat',
        baseBranch: 'main',
        createdAt: '2026-09-25T00:00:00.000Z',
        createdByApp: true,
      },
    ]);
    await invoke(IPC.agents.history, 'p1~wt-1');
    expect(history.listAgentHistory).toHaveBeenLastCalledWith('C:/code/app.worktrees/feat');
    await invoke(IPC.agents.history, 'p1');
    expect(history.listAgentHistory).toHaveBeenLastCalledWith('C:/code/app');
  });
});

describe('agent session usage', () => {
  it('reads the usage of the conversation the renderer names, by agent and id', async () => {
    const usage = { status: 'unsupported' };
    sessionUsage.readSessionUsage.mockResolvedValueOnce(usage);

    expect(await invoke(IPC.agents.sessionUsage, 'gemini-cli', 'abc-123')).toEqual(usage);
    expect(sessionUsage.readSessionUsage).toHaveBeenLastCalledWith('gemini-cli', 'abc-123');
  });

  it('turns away arguments that are not strings without reading anything', async () => {
    sessionUsage.readSessionUsage.mockClear();

    expect(await invoke(IPC.agents.sessionUsage, 'codex', { path: 'C:/secret' })).toEqual({
      status: 'unavailable',
    });
    expect(await invoke(IPC.agents.sessionUsage, undefined, 'abc')).toEqual({
      status: 'unavailable',
    });
    expect(sessionUsage.readSessionUsage).not.toHaveBeenCalled();
  });
});

describe('project usage', () => {
  const worktree = (id: string, projectId: string, path: string) => ({
    id,
    projectId,
    path,
    branch: id,
    baseBranch: 'main',
    createdAt: '2026-09-25T00:00:00.000Z',
    createdByApp: true,
  });

  beforeEach(() => {
    projectUsage.readProjectUsage.mockClear();
    userData.writeData('projects.json', [
      { id: 'p1', name: 'App', folderPath: 'C:/code/app', createdAt: '2026-01-01' },
      { id: 'p2', name: 'Other', folderPath: 'C:/code/other', createdAt: '2026-01-01' },
    ]);
    userData.writeData('worktrees.json', [
      worktree('wt-1', 'p1', 'C:/code/app.worktrees/feat'),
      worktree('wt-2', 'p1', 'C:/code/app.worktrees/fix'),
      worktree('wt-3', 'p2', 'C:/code/other.worktrees/x'),
    ]);
  });

  it('reads the project folder and each of its worktrees, and only those', async () => {
    const report = { status: 'ok', days: 30 };
    projectUsage.readProjectUsage.mockResolvedValueOnce(report);

    expect(await invoke(IPC.agents.projectUsage, 'p1', 30)).toEqual(report);
    expect(projectUsage.readProjectUsage).toHaveBeenCalledWith(
      ['C:/code/app', 'C:/code/app.worktrees/feat', 'C:/code/app.worktrees/fix'],
      30,
    );
  });

  it('reads everything when no period is given', async () => {
    await invoke(IPC.agents.projectUsage, 'p2', null);

    expect(projectUsage.readProjectUsage).toHaveBeenCalledWith(
      ['C:/code/other', 'C:/code/other.worktrees/x'],
      null,
    );
  });

  it('reads just that worktree when the id names one', async () => {
    await invoke(IPC.agents.projectUsage, 'p1~wt-2', null);

    expect(projectUsage.readProjectUsage).toHaveBeenCalledWith(['C:/code/app.worktrees/fix'], null);
  });

  it('has nothing to report for a project that is not there', async () => {
    expect(await invoke(IPC.agents.projectUsage, 'nope', null)).toEqual({ status: 'unavailable' });
    expect(projectUsage.readProjectUsage).not.toHaveBeenCalled();
  });

  it('turns away arguments that are not an id and a whole number of days', async () => {
    for (const [id, days] of [
      [42, null],
      [undefined, null],
      ['p1', '30'],
      ['p1', 0],
      ['p1', -7],
      ['p1', 1.5],
      ['p1', Number.NaN],
      ['p1', 100_000],
      ['p1', undefined],
    ] as const) {
      expect(await invoke(IPC.agents.projectUsage, id, days)).toEqual({ status: 'unavailable' });
    }
    expect(projectUsage.readProjectUsage).not.toHaveBeenCalled();
  });
});

describe('agents:contextUsage', () => {
  it('measures the context of the tab that asked', async () => {
    contextUsage.readSessionContextUsage.mockImplementation(async (id) =>
      id === 'tab-1' ? { tokens: 84_100, window: 200_000 } : null,
    );

    expect(await invoke(IPC.agents.contextUsage, 'tab-1')).toEqual({
      tokens: 84_100,
      window: 200_000,
    });
    expect(await invoke(IPC.agents.contextUsage, 'tab-2')).toBeNull();
  });

  it('turns away an id that is not a string', async () => {
    contextUsage.readSessionContextUsage.mockClear();

    expect(await invoke(IPC.agents.contextUsage, 42)).toBeNull();
    expect(contextUsage.readSessionContextUsage).not.toHaveBeenCalled();
  });
});
