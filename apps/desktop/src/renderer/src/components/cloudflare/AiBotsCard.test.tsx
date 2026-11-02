import type { CloudflareBotSettings } from '@shared/cloudflareTypes';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { BOTS, ipcError, ZONE } from './testing/fixtures';

/**
 * The Security tab's AI bots card: where AI crawlers are blocked, AI Labyrinth, Bot Preference
 * Sync and Bot Fight Mode, each with its state in words.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { AiBotsCard, PREFERENCE_SYNC_DOCS } = await import('./AiBotsCard');

function renderCard(bridge: Record<string, unknown>) {
  return renderWithProviders(<AiBotsCard zone={ZONE} />, { bridge });
}

function withBots(change: Partial<CloudflareBotSettings>): CloudflareBotSettings {
  return { ...BOTS, ...change };
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('AiBotsCard', () => {
  it('shimmers while the settings load', () => {
    const { container } = renderCard({
      'cloudflare.botSettings': () => new Promise(() => undefined),
    });
    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('names the permission the token is missing', async () => {
    renderCard({
      'cloudflare.botSettings': async () => {
        throw ipcError(
          'botSettings',
          'This token is not allowed to change bot settings. On Cloudflare, edit the token and add Zone > Bot Management > Edit, then check it again here.',
        );
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Zone > Bot Management > Edit');
  });

  it('shows each setting as it is', async () => {
    renderCard({
      'cloudflare.botSettings': async () =>
        withBots({ aiBots: 'only_on_ad_pages', preferenceSync: true }),
    });

    expect(await screen.findByRole('radio', { name: 'On ad pages' })).toBeChecked();
    expect(screen.getByText(/blocked on hostnames that show ads/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'AI Labyrinth' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Bot Preference Sync' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Bot Fight Mode' })).not.toBeChecked();
  });

  it('blocks AI bots everywhere', async () => {
    const { user, bridge } = renderCard({
      'cloudflare.botSettings': async () => BOTS,
      'cloudflare.changeBotSetting': async () => withBots({ aiBots: 'block' }),
    });

    await user.click(await screen.findByRole('radio', { name: 'Everywhere' }));

    expect(bridge.$fn('cloudflare.changeBotSetting')).toHaveBeenCalledWith(ZONE.id, {
      setting: 'aiBots',
      value: 'block',
    });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Everywhere' })).toBeChecked());
    expect(toast.success).toHaveBeenCalledWith('AI bots are blocked everywhere now.');
  });

  it('does nothing when the current choice is picked again', async () => {
    const changeBotSetting = vi.fn(async () => BOTS);
    const { user } = renderCard({
      'cloudflare.botSettings': async () => BOTS,
      'cloudflare.changeBotSetting': changeBotSetting,
    });
    await user.click(await screen.findByRole('radio', { name: 'Off' }));
    expect(changeBotSetting).not.toHaveBeenCalled();
  });

  it.each([
    ['AI Labyrinth', 'aiLabyrinth', 'AI Labyrinth is on.'],
    [
      'Bot Preference Sync',
      'preferenceSync',
      'Bot Preference Sync is on. robots.txt now starts with your AI bot choices.',
    ],
    ['Bot Fight Mode', 'fightMode', 'Bot Fight Mode is on.'],
  ] as const)('turns %s on', async (name, setting, done) => {
    const { user, bridge } = renderCard({
      'cloudflare.botSettings': async () => BOTS,
      'cloudflare.changeBotSetting': async () => withBots({ [setting]: true }),
    });

    await user.click(await screen.findByRole('switch', { name }));

    expect(bridge.$fn('cloudflare.changeBotSetting')).toHaveBeenCalledWith(ZONE.id, {
      setting,
      value: true,
    });
    await waitFor(() => expect(screen.getByRole('switch', { name })).toBeChecked());
    expect(toast.success).toHaveBeenCalledWith(done);
  });

  it('opens Cloudflare docs on Bot Preference Sync', async () => {
    const { user, bridge } = renderCard({ 'cloudflare.botSettings': async () => BOTS });
    await user.click(await screen.findByRole('button', { name: 'Learn more' }));
    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith(PREFERENCE_SYNC_DOCS);
  });

  it('points to Cloudflare for Bot Fight Mode on a plan with Super Bot Fight Mode', async () => {
    renderCard({ 'cloudflare.botSettings': async () => withBots({ fightMode: null }) });
    expect(await screen.findByText(/uses Super Bot Fight Mode instead/)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Bot Fight Mode' })).toBeNull();
  });

  it('passes on a refused change and keeps the switch as it was', async () => {
    const { user } = renderCard({
      'cloudflare.botSettings': async () => BOTS,
      'cloudflare.changeBotSetting': async () => {
        throw ipcError('changeBotSetting', 'Cloudflare said: Invalid value (code 1004)');
      },
    });

    await user.click(await screen.findByRole('switch', { name: 'AI Labyrinth' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Cloudflare said: Invalid value (code 1004)'),
    );
    expect(screen.getByRole('switch', { name: 'AI Labyrinth' })).not.toBeChecked();
  });
});
