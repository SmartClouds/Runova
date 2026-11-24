import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ipcError, ZONE } from './testing/fixtures';

/**
 * The purge menu in the zone's header: a full purge or a jump to the Purge cache card, from
 * whichever tab is open, for the moment a change goes out and visitors still see the old one.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { ZonePurgeMenu } = await import('./ZonePurgeMenu');

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('ZonePurgeMenu', () => {
  it('is a menu button, not a switch, and offers a full purge or a choice', async () => {
    const { user } = renderWithProviders(<ZonePurgeMenu zone={ZONE} onChoose={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: 'Purge cache' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.queryByRole('switch')).toBeNull();
    await user.click(trigger);

    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Choose URLs, folders or hostnames…', 'Purge everything…']);
  });

  it('opens the Purge cache card through its caller', async () => {
    const onChoose = vi.fn();
    const { user, bridge } = renderWithProviders(<ZonePurgeMenu zone={ZONE} onChoose={onChoose} />);

    await user.click(screen.getByRole('button', { name: 'Purge cache' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Choose URLs, folders or hostnames…' }),
    );

    await waitFor(() => expect(onChoose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(() => bridge.$fn('cloudflare.purgeCache')).toThrow();
  });

  it('purges everything only once the domain name is typed', async () => {
    const { user, bridge } = renderWithProviders(<ZonePurgeMenu zone={ZONE} onChoose={vi.fn()} />, {
      bridge: { 'cloudflare.purgeCache': async () => undefined },
    });

    await user.click(screen.getByRole('button', { name: 'Purge cache' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Purge everything…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Purge everything for example.com?' });
    const confirm = within(dialog).getByRole('button', { name: 'Purge everything' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), 'example.com');
    await user.click(confirm);

    expect(bridge.$fn('cloudflare.purgeCache')).toHaveBeenCalledWith(ZONE.id, { everything: true });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Purged everything for example.com.'),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the dialog open with the reason when the token cannot purge', async () => {
    const { user } = renderWithProviders(<ZonePurgeMenu zone={ZONE} onChoose={vi.fn()} />, {
      bridge: {
        'cloudflare.purgeCache': async () => {
          throw ipcError('purgeCache', 'This token is not allowed to purge the cache.');
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Purge cache' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Purge everything…' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/to confirm/), 'example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Purge everything' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('not allowed to purge');
  });
});
