import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../../../shared/defaultSettings';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { AiAccessSettings } from './AiAccessSettings';

const refreshAiAccessLaunchArgs = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/workspace/launch', () => ({ refreshAiAccessLaunchArgs }));

/**
 * Settings > AI access: the switch that lets agents use Runova, who may connect, how much they may
 * do without asking and where Runova asks. Each choice saves the moment it is made.
 */

function renderCard(saved: Partial<typeof DEFAULT_SETTINGS> = {}) {
  let settings = { ...DEFAULT_SETTINGS, ...saved };
  return renderWithProviders(<AiAccessSettings />, {
    bridge: {
      'settings.get': async () => settings,
      'settings.update': async (patch: Record<string, unknown>) => {
        settings = { ...settings, ...patch };
        return settings;
      },
    },
  });
}

describe('AiAccessSettings', () => {
  it('starts off, and turning it on saves and refreshes the flags new agent tabs get', async () => {
    const { user, bridge } = renderCard();

    const toggle = await screen.findByRole('switch', { name: 'Let AI agents use Runova' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/Agents can't use Runova/)).toBeTruthy();

    await user.click(toggle);

    expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({ aiAccessEnabled: true });
    await waitFor(() => expect(refreshAiAccessLaunchArgs).toHaveBeenCalled());
  });

  it('offers the three permission modes, with asking before sensitive actions recommended', async () => {
    const { user, bridge } = renderCard({ aiAccessEnabled: true });

    const group = await screen.findByRole('group', { name: 'What agents may do without asking' });
    const tiles = within(group).getAllByRole('button');
    expect(tiles.map((tile) => tile.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(within(tiles[1]).getByText('Recommended')).toBeTruthy();

    await user.click(within(group).getByRole('button', { name: /Full access/ }));
    expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({ aiAccessMode: 'full' });
    expect(
      await screen.findByText(/agents can change and delete things without asking/),
    ).toBeTruthy();
  });

  it('lets the user choose who can connect', async () => {
    const { user, bridge } = renderCard({ aiAccessEnabled: true });

    const group = await screen.findByRole('group', { name: 'Who can connect' });
    expect(within(group).getByRole('button', { name: /Runova only/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(within(group).getByRole('button', { name: /Runova and other apps/ }));
    expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({ aiAccessClients: 'both' });
    await waitFor(() => expect(refreshAiAccessLaunchArgs).toHaveBeenCalled());
  });

  it('lets the user choose where approvals are asked', async () => {
    const { user, bridge } = renderCard({ aiAccessEnabled: true });

    const group = await screen.findByRole('group', { name: 'Where Runova asks' });
    await user.click(within(group).getByRole('button', { name: /In the agent's session/ }));

    expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({ aiAccessPrompt: 'cli' });
  });

  it('lets the user stop attaching the server to the agent tabs Runova opens', async () => {
    const { user, bridge } = renderCard({ aiAccessEnabled: true });

    const attach = await screen.findByRole('switch', { name: 'Attach to agent tabs Runova opens' });
    await user.click(attach);

    expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({ aiAccessAttachToTabs: false });
  });

  it('hides attaching to Runova tabs when only other apps may connect', async () => {
    renderCard({ aiAccessEnabled: true, aiAccessClients: 'external' });

    const group = await screen.findByRole('group', { name: 'Who can connect' });
    await waitFor(() =>
      expect(within(group).getByRole('button', { name: /Other apps only/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    expect(screen.queryByRole('switch', { name: 'Attach to agent tabs Runova opens' })).toBeNull();
  });
});
