import type { CloudflareBotSettings, CloudflareZoneSettings } from '@shared/cloudflareTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { BOTS, ipcError, OTHER_ZONE, SETTINGS, ZONE } from './testing/fixtures';

/**
 * The switches in the zone's header, for the moments that cannot wait for a tab: development
 * mode while a change goes out, I'm Under Attack while the site is being flooded, and blocking AI
 * bots.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { ZoneQuickToggles } = await import('./ZoneQuickToggles');

function withSettings(change: Partial<CloudflareZoneSettings>): CloudflareZoneSettings {
  return { ...SETTINGS, ...change };
}

const UNDER_ATTACK = withSettings({ securityLevel: { value: 'under_attack', editable: true } });

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('ZoneQuickToggles', () => {
  it('shimmers while the settings load', () => {
    const { container } = renderWithProviders(<ZoneQuickToggles zone={ZONE} />, {
      bridge: { 'cloudflare.zoneSettings': () => new Promise(() => undefined) },
    });
    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('stays out of the way when nothing can be read', async () => {
    const { bridge } = renderWithProviders(<ZoneQuickToggles zone={ZONE} />, {
      bridge: {
        'cloudflare.zoneSettings': async () => {
          throw ipcError('zoneSettings', 'Could not reach Cloudflare.');
        },
        'cloudflare.botSettings': async () => {
          throw ipcError('botSettings', 'Could not reach Cloudflare.');
        },
      },
    });
    await waitFor(() => expect(bridge.$fn('cloudflare.zoneSettings')).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('group')).toBeNull());
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('keeps Block AI bots when the zone settings cannot be read', async () => {
    renderWithProviders(<ZoneQuickToggles zone={ZONE} />, {
      bridge: {
        'cloudflare.zoneSettings': async () => {
          throw ipcError('zoneSettings', 'Could not reach Cloudflare.');
        },
      },
    });
    expect(await screen.findByRole('switch', { name: 'Block AI bots' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('switch', { name: 'Development mode' })).toBeNull(),
    );
  });

  it('leaves out only Block AI bots when the token has no Bot Management', async () => {
    renderWithProviders(<ZoneQuickToggles zone={ZONE} />, {
      bridge: {
        'cloudflare.zoneSettings': async () => SETTINGS,
        'cloudflare.botSettings': async () => {
          throw ipcError('botSettings', 'This token is not allowed to change bot settings.');
        },
      },
    });
    expect(await screen.findByRole('switch', { name: 'Development mode' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: "I'm Under Attack" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('switch', { name: 'Block AI bots' })).toBeNull());
  });

  it('says what each one is set to', async () => {
    renderWithProviders(<ZoneQuickToggles zone={ZONE} />, {
      bridge: {
        'cloudflare.zoneSettings': async () =>
          withSettings({
            developmentMode: { value: 'on', secondsRemaining: 5400, editable: true },
          }),
      },
    });

    const group = await screen.findByRole('group', { name: 'Quick switches' });
    const development = await within(group).findByRole('switch', { name: 'Development mode' });
    expect(development).toBeChecked();
    expect(development).toHaveTextContent('On, 1 h 30 min left');
    const attack = within(group).getByRole('switch', { name: "I'm Under Attack" });
    expect(attack).not.toBeChecked();
    expect(attack).toHaveTextContent('Off');
    const bots = await within(group).findByRole('switch', { name: 'Block AI bots' });
    expect(bots).not.toBeChecked();
    expect(bots).toHaveTextContent('Off');
  });

  it('blocks AI bots, and turns them back on where they were blocked before', async () => {
    const zone = { ...OTHER_ZONE, id: 'b1b2c3d4e5f60718293a4b5c6d7e8f90' };
    let current: CloudflareBotSettings = { ...BOTS, aiBots: 'only_on_ad_pages' };
    const { user, bridge } = renderWithProviders(<ZoneQuickToggles zone={zone} />, {
      bridge: {
        'cloudflare.zoneSettings': async () => SETTINGS,
        'cloudflare.botSettings': async () => current,
        'cloudflare.changeBotSetting': async (
          _zone: string,
          change: { value: CloudflareBotSettings['aiBots'] },
        ) => {
          current = { ...current, aiBots: change.value };
          return current;
        },
      },
    });

    const bots = await screen.findByRole('switch', { name: 'Block AI bots' });
    expect(bots).toBeChecked();
    expect(bots).toHaveTextContent('On, ad pages');

    await user.click(bots);
    expect(bridge.$fn('cloudflare.changeBotSetting')).toHaveBeenLastCalledWith(zone.id, {
      setting: 'aiBots',
      value: 'disabled',
    });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Block AI bots' })).not.toBeChecked(),
    );
    expect(toast.success).toHaveBeenLastCalledWith('AI bots are not blocked any more.');

    await user.click(screen.getByRole('switch', { name: 'Block AI bots' }));
    expect(bridge.$fn('cloudflare.changeBotSetting')).toHaveBeenLastCalledWith(zone.id, {
      setting: 'aiBots',
      value: 'only_on_ad_pages',
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenLastCalledWith('AI bots are blocked on pages with ads now.'),
    );
  });

  it('blocks AI bots everywhere when it does not know how they were blocked before', async () => {
    const zone = { ...OTHER_ZONE, id: 'c1b2c3d4e5f60718293a4b5c6d7e8f90' };
    const { user, bridge } = renderWithProviders(<ZoneQuickToggles zone={zone} />, {
      bridge: {
        'cloudflare.zoneSettings': async () => SETTINGS,
        'cloudflare.botSettings': async () => BOTS,
        'cloudflare.changeBotSetting': async () => ({ ...BOTS, aiBots: 'block' }),
      },
    });

    await user.click(await screen.findByRole('switch', { name: 'Block AI bots' }));

    expect(bridge.$fn('cloudflare.changeBotSetting')).toHaveBeenCalledWith(zone.id, {
      setting: 'aiBots',
      value: 'block',
    });
    expect(await screen.findByRole('switch', { name: 'Block AI bots' })).toHaveTextContent(
      'On, everywhere',
    );
  });

  it('turns development mode on', async () => {
    const { user, bridge } = renderWithProviders(<ZoneQuickToggles zone={ZONE} />, {
      bridge: {
        'cloudflare.zoneSettings': async () => SETTINGS,
        'cloudflare.changeSetting': async () =>
          withSettings({
            developmentMode: { value: 'on', secondsRemaining: 10800, editable: true },
          }),
      },
    });

    await user.click(await screen.findByRole('switch', { name: 'Development mode' }));

    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenCalledWith(ZONE.id, {
      setting: 'developmentMode',
      value: 'on',
    });
    expect(await screen.findByRole('switch', { name: 'Development mode' })).toBeChecked();
    expect(toast.success).toHaveBeenCalledWith('Development mode is on for three hours.');
  });

  it("turns I'm Under Attack on, and back to the level it was before", async () => {
    const HIGH = withSettings({ securityLevel: { value: 'high', editable: true } });
    let current = HIGH;
    const { user, bridge } = renderWithProviders(<ZoneQuickToggles zone={ZONE} />, {
      bridge: {
        'cloudflare.zoneSettings': async () => current,
        'cloudflare.changeSetting': async (_zone: string, change: { value: string }) => {
          current = change.value === 'under_attack' ? UNDER_ATTACK : HIGH;
          return current;
        },
      },
    });

    await user.click(await screen.findByRole('switch', { name: "I'm Under Attack" }));
    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenLastCalledWith(ZONE.id, {
      setting: 'securityLevel',
      value: 'under_attack',
    });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: "I'm Under Attack" })).toBeChecked(),
    );
    expect(toast.success).toHaveBeenLastCalledWith(
      "I'm Under Attack is on. Every visitor gets a short check first.",
    );

    await user.click(screen.getByRole('switch', { name: "I'm Under Attack" }));
    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenLastCalledWith(ZONE.id, {
      setting: 'securityLevel',
      value: 'high',
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenLastCalledWith(
        "I'm Under Attack is off. Security level is High again.",
      ),
    );
  });

  it('falls back to Medium when it does not know the level from before', async () => {
    const zone = { ...OTHER_ZONE, id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' };
    const { user, bridge } = renderWithProviders(<ZoneQuickToggles zone={zone} />, {
      bridge: {
        'cloudflare.zoneSettings': async () => UNDER_ATTACK,
        'cloudflare.changeSetting': async () => SETTINGS,
      },
    });

    await user.click(await screen.findByRole('switch', { name: "I'm Under Attack" }));

    expect(bridge.$fn('cloudflare.changeSetting')).toHaveBeenCalledWith(zone.id, {
      setting: 'securityLevel',
      value: 'medium',
    });
  });

  it('locks a switch Cloudflare says cannot be changed', async () => {
    renderWithProviders(<ZoneQuickToggles zone={ZONE} />, {
      bridge: {
        'cloudflare.zoneSettings': async () =>
          withSettings({
            developmentMode: { value: 'off', secondsRemaining: 0, editable: false },
          }),
      },
    });
    expect(await screen.findByRole('switch', { name: 'Development mode' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: "I'm Under Attack" })).toBeEnabled();
  });

  it('passes on a refused change', async () => {
    const { user } = renderWithProviders(<ZoneQuickToggles zone={ZONE} />, {
      bridge: {
        'cloudflare.zoneSettings': async () => SETTINGS,
        'cloudflare.changeSetting': async () => {
          throw ipcError('changeSetting', 'Cloudflare said: Invalid value (code 1007)');
        },
      },
    });

    await user.click(await screen.findByRole('switch', { name: "I'm Under Attack" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Cloudflare said: Invalid value (code 1007)'),
    );
  });
});
