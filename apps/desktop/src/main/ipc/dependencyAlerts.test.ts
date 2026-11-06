import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_DEPENDENCY_SUMMARY } from '../../shared/dependencyAlerts';
import { IPC } from '../../shared/ipcChannels';
import { electronState, expectChannelsCovered, invoke, loadIpc } from '../../test/main/ipcHarness';

/** What the renderer sends about dependency alerts reaches the account's API only in the shape it expects. */

const alerts = vi.hoisted(() => ({
  summary: vi.fn(),
  refresh: vi.fn(),
  settings: vi.fn(),
  updateSettings: vi.fn(),
  mute: vi.fn(),
  telegramLink: vi.fn(),
  telegramLinkCode: vi.fn(),
  telegramUnlink: vi.fn(),
}));

vi.mock('../account/live', () => ({ getDependencyAlerts: () => alerts }));

expectChannelsCovered(IPC.dependencyAlerts, [IPC.dependencyAlerts.onChanged]);

beforeEach(async () => {
  for (const fn of Object.values(alerts)) fn.mockReset();
  await loadIpc(
    () => import('./dependencyAlerts'),
    (module) => module.registerDependencyAlertHandlers(),
  );
});

describe('reading', () => {
  it('hands back the summary, a fresh one, the settings and the Telegram link', async () => {
    alerts.summary.mockReturnValue(EMPTY_DEPENDENCY_SUMMARY);
    alerts.refresh.mockResolvedValue({ ...EMPTY_DEPENDENCY_SUMMARY, signedIn: true });
    alerts.settings.mockResolvedValue({ enabled: true });
    alerts.telegramLink.mockResolvedValue({ available: true, linked: false });

    expect(await invoke(IPC.dependencyAlerts.summary)).toEqual(EMPTY_DEPENDENCY_SUMMARY);
    expect(await invoke(IPC.dependencyAlerts.refresh)).toMatchObject({ signedIn: true });
    expect(await invoke(IPC.dependencyAlerts.settings)).toEqual({ enabled: true });
    expect(await invoke(IPC.dependencyAlerts.telegramLink)).toEqual({
      available: true,
      linked: false,
    });
  });
});

describe('changing', () => {
  it('passes only known settings of the right type', async () => {
    alerts.updateSettings.mockResolvedValue({ minor: true });

    await invoke(IPC.dependencyAlerts.updateSettings, {
      minor: true,
      securityMinSeverity: 'critical',
    });

    expect(alerts.updateSettings).toHaveBeenCalledWith({
      minor: true,
      securityMinSeverity: 'critical',
    });
    await expect(invoke(IPC.dependencyAlerts.updateSettings, { minor: 'yes' })).rejects.toThrow(
      /not a dependency alert setting/,
    );
    await expect(
      invoke(IPC.dependencyAlerts.updateSettings, { securityMinSeverity: 'severe' }),
    ).rejects.toThrow();
    await expect(invoke(IPC.dependencyAlerts.updateSettings, { colour: 'red' })).rejects.toThrow();
  });

  it('mutes a project by its id', async () => {
    alerts.mute.mockResolvedValue(EMPTY_DEPENDENCY_SUMMARY);

    await invoke(IPC.dependencyAlerts.mute, 'p-shop', true);

    expect(alerts.mute).toHaveBeenCalledWith('p-shop', true);
    await expect(invoke(IPC.dependencyAlerts.mute, 'p-shop', 'yes')).rejects.toThrow();
  });
});

describe('Telegram', () => {
  it('opens the bot link the server made, and nothing else', async () => {
    alerts.telegramLinkCode.mockResolvedValueOnce({
      url: 'https://t.me/RunovaHQBot?start=abc_123-x',
      expiresAt: '',
    });

    await invoke(IPC.dependencyAlerts.telegramConnect);

    expect(electronState.openedExternal).toEqual(['https://t.me/RunovaHQBot?start=abc_123-x']);
    alerts.telegramLinkCode.mockResolvedValueOnce({
      url: 'https://evil.example/t.me/x?start=1',
      expiresAt: '',
    });
    await expect(invoke(IPC.dependencyAlerts.telegramConnect)).rejects.toThrow(
      /not a Telegram bot link/,
    );
    expect(electronState.openedExternal).toHaveLength(1);
  });

  it('unlinks the chat', async () => {
    await invoke(IPC.dependencyAlerts.telegramUnlink);

    expect(alerts.telegramUnlink).toHaveBeenCalled();
  });
});
