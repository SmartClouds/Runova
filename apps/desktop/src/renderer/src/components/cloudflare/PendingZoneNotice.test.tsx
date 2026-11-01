import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { deferred, ipcError, OTHER_ZONE } from './testing/fixtures';

/**
 * A zone that waits for its registrar shows the name servers to set, ready to copy, and a way to
 * ask Cloudflare to look again now instead of on its own schedule.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { PendingZoneNotice } = await import('./PendingZoneNotice');

beforeEach(() => {
  toast.success.mockClear();
});

describe('PendingZoneNotice', () => {
  it('says the zone is waiting and lists its name servers to copy', () => {
    renderWithProviders(<PendingZoneNotice zone={OTHER_ZONE} />);
    expect(screen.getByText(/waiting for your registrar/)).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Cloudflare name servers' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Copy bob.ns.cloudflare.com' })).toBeInTheDocument();
  });

  it('asks Cloudflare to check now, then lists the zones again', async () => {
    const pending = deferred<void>();
    const { user, bridge, queryClient } = renderWithProviders(
      <PendingZoneNotice zone={OTHER_ZONE} />,
      { bridge: { 'cloudflare.checkActivation': () => pending.promise } },
    );
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: 'Check name servers now' }));
    expect(bridge.$fn('cloudflare.checkActivation')).toHaveBeenCalledWith(OTHER_ZONE.id);
    expect(screen.getByRole('button', { name: /Asking Cloudflare/ })).toBeDisabled();
    pending.resolve();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Cloudflare is checking the name servers. This can take a few minutes.',
      ),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.cloudflareAccountZones(OTHER_ZONE.accountId),
    });
    expect(screen.getByRole('button', { name: 'Check name servers now' })).toBeEnabled();
  });

  it("shows Cloudflare's answer when the check is refused", async () => {
    const { user } = renderWithProviders(<PendingZoneNotice zone={OTHER_ZONE} />, {
      bridge: {
        'cloudflare.checkActivation': async () => {
          throw ipcError('checkActivation', 'Cloudflare was asked to check recently.');
        },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Check name servers now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cloudflare was asked to check recently.',
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says what to add to the token when it may not ask for a check', async () => {
    const { user } = renderWithProviders(<PendingZoneNotice zone={OTHER_ZONE} />, {
      bridge: {
        'cloudflare.checkActivation': async () => {
          throw ipcError(
            'checkActivation',
            '[cloudflare:missing-permission:zoneEdit] This token is not allowed to add domains.',
          );
        },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Check name servers now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Zone > Zone > Edit');
  });
});
