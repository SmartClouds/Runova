import type { RemotePairedDevice } from '@shared/apiTypes';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * The only way for the person at a host to take a paired LAN device's access away, short of
 * deleting a file in userData by hand.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { PairedDevicesCard } = await import('./PairedDevicesCard');

const PHONE: RemotePairedDevice = {
  id: 'dev-1',
  deviceName: 'Pixel 8',
  createdAt: Date.now() - 86_400_000,
  lastSeenAt: Date.now() - 60_000,
};

describe('PairedDevicesCard', () => {
  it('revokes a paired device after a confirm and drops it from the list', async () => {
    let devices = [PHONE];
    const { user, bridge } = renderWithProviders(<PairedDevicesCard />, {
      bridge: {
        'remote.listPairedDevices': async () => devices,
        'remote.revokePairedDevice': async () => {
          devices = [];
        },
      },
    });

    expect(await screen.findByText('Pixel 8')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Revoke Pixel 8' }));

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Remove "Pixel 8"?' }));
    expect(bridge.$fn('remote.revokePairedDevice')).toHaveBeenCalledWith('dev-1');
    expect(await screen.findByText('No paired devices')).toBeTruthy();
  });

  it('keeps the device when the confirm is turned down', async () => {
    confirm.mockResolvedValueOnce(false);
    const revoke = vi.fn(async () => undefined);
    const { user } = renderWithProviders(<PairedDevicesCard />, {
      bridge: {
        'remote.listPairedDevices': async () => [PHONE],
        'remote.revokePairedDevice': revoke,
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Revoke Pixel 8' }));

    expect(confirm).toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(screen.getByText('Pixel 8')).toBeTruthy();
  });
});
