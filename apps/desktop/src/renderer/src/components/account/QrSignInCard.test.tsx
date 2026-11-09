import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { QrSignInCard } from './QrSignInCard';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const CODE = { id: 7, qrDataUrl: 'data:image/png;base64,AAAA', expiresAt: '2026-11-09T12:00:00Z' };
const status = (value: string, matchCode: string | null = null) => ({
  status: value,
  matchCode,
  expiresAt: '2026-11-09T12:00:00Z',
});

function shown(bridge: Record<string, unknown>) {
  return renderWithProviders(<QrSignInCard />, {
    bridge: { 'account.qrSignIn': CODE, 'account.sessions': [], ...bridge },
  });
}

describe('QrSignInCard', () => {
  it('shows the code once asked', async () => {
    const view = shown({ 'account.qrSignInStatus': status('waiting') });

    await view.user.click(screen.getByRole('button', { name: 'Show QR code' }));

    expect(await screen.findByAltText(/QR code/)).toHaveAttribute('src', CODE.qrDataUrl);
  });

  it('shows the digits after a scan and approves that phone', async () => {
    const view = shown({
      'account.qrSignInStatus': status('scanned', '0420'),
    });

    await view.user.click(screen.getByRole('button', { name: 'Show QR code' }));
    expect(await screen.findByText('0420')).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(view.bridge.$fn('account.qrSignInDecide')).toHaveBeenCalledWith(7, true),
    );
  });

  it('turns a phone down', async () => {
    const view = shown({
      'account.qrSignInStatus': status('scanned', '0420'),
    });

    await view.user.click(screen.getByRole('button', { name: 'Show QR code' }));
    await view.user.click(await screen.findByRole('button', { name: 'Not my phone' }));

    await waitFor(() =>
      expect(view.bridge.$fn('account.qrSignInDecide')).toHaveBeenCalledWith(7, false),
    );
    expect(await screen.findByRole('button', { name: 'Show QR code' })).toBeInTheDocument();
  });

  it('says when the phone is in', async () => {
    const view = shown({ 'account.qrSignInStatus': status('approved') });

    await view.user.click(screen.getByRole('button', { name: 'Show QR code' }));

    expect(await screen.findByText('Your phone is signed in.')).toBeInTheDocument();
  });

  it('offers a new code when this one ran out', async () => {
    const view = shown({ 'account.qrSignInStatus': status('expired') });

    await view.user.click(screen.getByRole('button', { name: 'Show QR code' }));

    expect(await screen.findByRole('button', { name: 'Show a new code' })).toBeInTheDocument();
  });
});
