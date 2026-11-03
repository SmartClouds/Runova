import type { AiAccessActivityEntry, AiAccessToolInfo } from '@shared/aiAccessTypes';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../../../shared/defaultSettings';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { AiAccessActivityCard } from './AiAccessActivityCard';
import { AiAccessConnectCard } from './AiAccessConnectCard';
import { AiAccessToolsCard } from './AiAccessToolsCard';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));
vi.mock('@/lib/workspace/launch', () => ({
  refreshAiAccessLaunchArgs: vi.fn(async () => undefined),
}));

/** The rest of Settings > AI access: connecting other apps, what agents can do, what they did. */

function settingsBridge(saved: Partial<typeof DEFAULT_SETTINGS>) {
  let settings = { ...DEFAULT_SETTINGS, aiAccessEnabled: true, ...saved };
  return {
    'settings.get': async () => settings,
    'settings.update': async (patch: Record<string, unknown>) => {
      settings = { ...settings, ...patch };
      return settings;
    },
  };
}

describe('AiAccessConnectCard', () => {
  const status = [
    { id: 'claude', label: 'Claude Code', installed: true, connected: true },
    { id: 'codex', label: 'Codex', installed: true, connected: false },
  ];

  it('offers to let other apps in while only Runova tabs may connect', async () => {
    const { user, bridge } = renderWithProviders(<AiAccessConnectCard />, {
      bridge: {
        ...settingsBridge({ aiAccessClients: 'runova' }),
        'aiAccess.externalStatus': status,
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Let other apps connect too' }));
    expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ aiAccessClients: 'both' });
    expect(await screen.findByText('Claude Code')).toBeTruthy();
  });

  it('shows which CLIs are connected and connects one in a click', async () => {
    const { user, bridge } = renderWithProviders(<AiAccessConnectCard />, {
      bridge: {
        ...settingsBridge({ aiAccessClients: 'both' }),
        'aiAccess.externalStatus': status,
        'aiAccess.connectExternal': { ok: true },
      },
    });

    const claude = (await screen.findByText('Claude Code')).closest('li') as HTMLElement;
    expect(within(claude).getByText('Connected')).toBeTruthy();
    const codex = screen.getByText('Codex').closest('li') as HTMLElement;

    await user.click(within(codex).getByRole('button', { name: 'Add to Codex' }));

    expect(bridge.$fn('aiAccess.connectExternal')).toHaveBeenCalledWith('codex');
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Codex')),
    );
  });

  it('says what went wrong when a CLI refuses', async () => {
    const { user } = renderWithProviders(<AiAccessConnectCard />, {
      bridge: {
        ...settingsBridge({ aiAccessClients: 'both' }),
        'aiAccess.externalStatus': status,
        'aiAccess.disconnectExternal': { ok: false, error: 'claude: not found' },
      },
    });

    const claude = (await screen.findByText('Claude Code')).closest('li') as HTMLElement;
    await user.click(within(claude).getByRole('button', { name: 'Remove from Claude Code' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('claude: not found'));
  });

  it('copies the config block for any other app', async () => {
    renderWithProviders(<AiAccessConnectCard />, {
      bridge: {
        ...settingsBridge({ aiAccessClients: 'external' }),
        'aiAccess.externalStatus': status,
        'aiAccess.configSnippet': async () => '{"mcpServers":{}}',
      },
    });
    // Set after rendering: setting user-event up swaps the clipboard for its own.
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    fireEvent.click(await screen.findByRole('button', { name: 'Copy config' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('{"mcpServers":{}}'));
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Copied'));
  });
});

describe('AiAccessToolsCard', () => {
  const tools: AiAccessToolInfo[] = [
    {
      name: 'projects_list',
      area: 'projects',
      title: 'List projects',
      description: 'Every project.',
      risk: 'read',
    },
    {
      name: 'project_update_notes',
      area: 'projects',
      title: 'Update notes',
      description: 'Notes.',
      risk: 'write',
    },
    {
      name: 'env_save_file',
      area: 'environments',
      title: 'Save an env file',
      description: 'Saves.',
      risk: 'sensitive',
    },
  ];

  it('groups the tools by area and says which ones ask under the current mode', async () => {
    const { user } = renderWithProviders(<AiAccessToolsCard />, {
      bridge: { ...settingsBridge({ aiAccessMode: 'sensitive' }), 'aiAccess.listTools': tools },
    });

    const projects = await screen.findByRole('button', { name: /Projects/ });
    expect(within(projects).getByText('2 tools')).toBeTruthy();
    await user.click(projects);
    expect(projects).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list', { name: 'Projects tools' });
    expect(within(list).getAllByText('Runs')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /Environments/ }));
    const env = screen.getByRole('list', { name: 'Environments tools' });
    expect(within(env).getByText('Asks')).toBeTruthy();
    expect(within(env).getByText('Sensitive')).toBeTruthy();
    expect(within(env).getByText('env_save_file')).toBeTruthy();
  });
});

describe('AiAccessActivityCard', () => {
  const entry = (over: Partial<AiAccessActivityEntry>): AiAccessActivityEntry => ({
    id: 'e1',
    at: Date.now() - 60_000,
    tool: 'env_save_file',
    toolTitle: 'Save an env file',
    area: 'environments',
    risk: 'sensitive',
    agent: 'Claude Code',
    callerKind: 'runova',
    projectId: 'p1',
    projectName: 'Shop',
    outcome: 'approved',
    ...over,
  });

  it('says so when nothing has happened yet', async () => {
    renderWithProviders(<AiAccessActivityCard />, { bridge: { 'aiAccess.activity': [] } });
    expect(await screen.findByText(/Nothing yet/)).toBeTruthy();
  });

  it('lists what agents did with the outcome, and adds new calls as they happen', async () => {
    const { bridge } = renderWithProviders(<AiAccessActivityCard />, {
      bridge: {
        'aiAccess.activity': [
          entry({}),
          entry({ id: 'e2', outcome: 'denied', toolTitle: 'Send a request' }),
        ],
      },
    });

    expect(await screen.findByText('Save an env file')).toBeTruthy();
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.getByText('Denied')).toBeTruthy();
    expect(screen.getAllByText(/Claude Code · Shop/)).toHaveLength(2);

    act(() =>
      bridge.$emit(
        'aiAccess.onActivity',
        entry({ id: 'e3', outcome: 'auto', toolTitle: 'List projects' }),
      ),
    );
    expect(await screen.findByText('List projects')).toBeTruthy();
    expect(screen.getByText('Ran')).toBeTruthy();
  });

  it('clears the list', async () => {
    const { user, bridge } = renderWithProviders(<AiAccessActivityCard />, {
      bridge: { 'aiAccess.activity': [entry({})] },
    });

    await screen.findByText('Save an env file');
    bridge.$set('aiAccess.activity', []);
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(bridge.$fn('aiAccess.clearActivity')).toHaveBeenCalled();
    expect(await screen.findByText(/Nothing yet/)).toBeTruthy();
  });
});
