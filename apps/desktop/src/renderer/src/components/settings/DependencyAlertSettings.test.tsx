import type {
  DependencyAlertSettings as Settings,
  TelegramLinkView,
} from '@shared/dependencyAlerts';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { DependencyAlertSettings } from './DependencyAlertSettings';

/**
 * The Package updates card in Settings > Notifications (E51). The settings live on the Runova
 * account, so they are the same in the app and on the website, and each change saves at once.
 */

const DEFAULTS: Settings = {
  enabled: true,
  securityMinSeverity: 'high',
  deprecated: true,
  major: true,
  minor: false,
  patch: false,
  inApp: true,
  telegram: true,
};

const NOT_LINKED: TelegramLinkView = {
  available: true,
  linked: false,
  botUsername: 'RunovaHQBot',
  chatName: null,
  linkedAt: null,
};

function render(
  options: { signedIn?: boolean; saved?: Partial<Settings>; telegram?: TelegramLinkView } = {},
) {
  let stored: Settings = { ...DEFAULTS, ...options.saved };
  return renderWithProviders(<DependencyAlertSettings />, {
    bridge: {
      'account.status': {
        state: options.signedIn === false ? 'signed-out' : 'signed-in',
        deviceId: 'd1',
      },
      'dependencyAlerts.settings': async () => stored,
      'dependencyAlerts.updateSettings': async (patch: Partial<Settings>) => {
        stored = { ...stored, ...patch };
        return stored;
      },
      'dependencyAlerts.telegramLink': options.telegram ?? NOT_LINKED,
    },
  });
}

describe('DependencyAlertSettings', () => {
  it('shows the account settings: on, high and above, deprecations and majors', async () => {
    render();

    expect(await screen.findByRole('switch', { name: 'Package update alerts' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Security issues at' })).toHaveTextContent('High');
    expect(screen.getByRole('checkbox', { name: 'Deprecated packages' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Major updates' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Minor updates' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Patch updates' })).not.toBeChecked();
  });

  it('saves each change on the account at once', async () => {
    const { user, bridge } = render();

    await user.click(await screen.findByRole('checkbox', { name: 'Minor updates' }));

    await waitFor(() =>
      expect(bridge.$fn('dependencyAlerts.updateSettings')).toHaveBeenCalledWith({ minor: true }),
    );
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Minor updates' })).toBeChecked(),
    );
  });

  it('can be turned off, which greys out the kinds', async () => {
    const { user, bridge } = render();

    await user.click(await screen.findByRole('switch', { name: 'Package update alerts' }));

    await waitFor(() =>
      expect(bridge.$fn('dependencyAlerts.updateSettings')).toHaveBeenCalledWith({
        enabled: false,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Major updates' })).toBeDisabled(),
    );
  });

  it('links Telegram through the bot, and shows the chat once linked', async () => {
    const { user, bridge } = render();

    await user.click(await screen.findByRole('button', { name: 'Link Telegram' }));
    expect(bridge.$fn('dependencyAlerts.telegramConnect')).toHaveBeenCalled();

    bridge.$set('dependencyAlerts.telegramLink', {
      ...NOT_LINKED,
      linked: true,
      chatName: '@sam_dev',
    });
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText(/@sam_dev/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unlink Telegram' }));
    expect(bridge.$fn('dependencyAlerts.telegramUnlink')).toHaveBeenCalled();
  });

  it('says when the site has no Telegram bot', async () => {
    render({ telegram: { ...NOT_LINKED, available: false, botUsername: null } });

    expect(await screen.findByText(/Telegram is not available/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link Telegram' })).not.toBeInTheDocument();
  });

  it('asks to sign in first when there is no account here', async () => {
    const { bridge } = render({ signedIn: false });

    expect(await screen.findByText(/Sign in to your Runova account/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    // Nothing asks the server for settings without an account.
    expect(() => bridge.$fn('dependencyAlerts.settings')).toThrow(/not been touched/);
  });
});
