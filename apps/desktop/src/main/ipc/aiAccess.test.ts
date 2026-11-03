import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccessApproval, AiAccessToolInfo } from '../../shared/aiAccessTypes';
import { IPC } from '../../shared/ipcChannels';
import { FakeBrowserWindow } from '../../test/main/electronMock';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The window's side of AI access: what Settings lists, the approval dialog and its answers, the
 * activity list, connecting other apps and the flags a new agent tab starts with.
 */

const external = {
  status: vi.fn(async () => [
    { id: 'claude', label: 'Claude Code', installed: true, connected: false },
  ]),
  connect: vi.fn(async (_id: string) => ({ ok: true })),
  disconnect: vi.fn(async (_id: string) => ({ ok: true })),
};

vi.mock('../aiAccess/external', () => ({
  machineExternalDeps: () => ({}),
  externalClientStatus: () => external.status(),
  connectExternalClient: (id: string) => external.connect(id),
  disconnectExternalClient: (id: string) => external.disconnect(id),
}));

vi.mock('./terminal', () => ({ terminalSessionInfo: () => undefined }));

const userData = useTempUserData();

expectChannelsCovered(IPC.aiAccess, [
  IPC.aiAccess.onApprovalsChanged,
  IPC.aiAccess.onActivity,
  IPC.aiAccess.onDataChanged,
]);

async function load() {
  await loadIpc(
    () => import('./aiAccess'),
    (module) => module.registerAiAccessHandlers(),
  );
  return import('../aiAccess/service');
}

beforeEach(() => {
  external.connect.mockClear();
  external.disconnect.mockClear();
  FakeBrowserWindow.instances = [];
});

describe('AI access IPC', () => {
  it('lists every tool for Settings', async () => {
    await load();
    const tools = await invoke<AiAccessToolInfo[]>(IPC.aiAccess.listTools);
    expect(tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'runova_whoami', risk: 'read' })]),
    );
  });

  it('shows what waits on the user and takes the answer from the window', async () => {
    const service = await load();
    const window = new FakeBrowserWindow({});
    const { decision } = service.aiAccessBroker.request({
      connectionId: 'c',
      channel: 'modal',
      tool: 'env_save_file',
      toolTitle: 'Save an env file',
      area: 'environments',
      risk: 'sensitive',
      agent: 'Claude Code',
      callerKind: 'runova',
      projectId: null,
      projectName: null,
      preview: { title: 'Save .env' },
      cliFallback: false,
      payload: null,
    });

    const pending = await invoke<AiAccessApproval[]>(IPC.aiAccess.pendingApprovals);
    expect(pending).toEqual([expect.objectContaining({ tool: 'env_save_file' })]);
    expect(window.webContents.sentOn(IPC.aiAccess.onApprovalsChanged)).toHaveLength(1);

    expect(await invoke(IPC.aiAccess.decide, { id: pending[0].id, decision: 'allow' })).toBe(true);
    await expect(decision).resolves.toBe('allow');
    expect(await invoke(IPC.aiAccess.decide, { id: pending[0].id, decision: 'allow' })).toBe(false);
    expect(await invoke(IPC.aiAccess.decide, { id: 'x', decision: 'maybe' })).toBe(false);
  });

  it('lists and clears the activity, and tells the window about new entries', async () => {
    await load();
    const window = new FakeBrowserWindow({});
    const { aiAccessActivity } = await import('../aiAccess/audit');
    await aiAccessActivity.record({
      tool: 'projects_list',
      toolTitle: 'List projects',
      area: 'projects',
      risk: 'read',
      agent: 'Codex',
      callerKind: 'external',
      projectId: null,
      projectName: null,
      outcome: 'auto',
    });

    expect(await invoke(IPC.aiAccess.activity)).toEqual([
      expect.objectContaining({ tool: 'projects_list' }),
    ]);
    expect(window.webContents.sentOn(IPC.aiAccess.onActivity)).toHaveLength(1);
    await invoke(IPC.aiAccess.clearActivity);
    expect(await invoke(IPC.aiAccess.activity)).toEqual([]);
  });

  it('connects and disconnects other apps, refusing ones it does not know', async () => {
    await load();

    expect(await invoke(IPC.aiAccess.externalStatus)).toEqual([
      expect.objectContaining({ id: 'claude' }),
    ]);
    expect(await invoke(IPC.aiAccess.connectExternal, 'claude')).toEqual({ ok: true });
    expect(external.connect).toHaveBeenCalledWith('claude');
    expect(await invoke(IPC.aiAccess.disconnectExternal, 'codex')).toEqual({ ok: true });
    expect(await invoke(IPC.aiAccess.connectExternal, 'cursor')).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(external.connect).toHaveBeenCalledTimes(1);
  });

  it('gives the config block other apps can paste', async () => {
    await load();
    const snippet = await invoke<string>(IPC.aiAccess.configSnippet);
    expect(JSON.parse(snippet).mcpServers.runova_app.command).toBe('node');
  });

  it('gives a new agent tab its flags only while the settings allow it', async () => {
    await load();
    expect(await invoke(IPC.aiAccess.launchArgs, 'claude-code')).toEqual([]);

    userData.writeData('settings.json', { aiAccessEnabled: true });
    expect(await invoke(IPC.aiAccess.launchArgs, 'claude-code')).toEqual(
      expect.arrayContaining(['--mcp-config']),
    );
    expect(await invoke(IPC.aiAccess.launchArgs, 42)).toEqual([]);
  });
});
