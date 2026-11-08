import type { AnywhereTrustedPhone } from '@shared/anywhere';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { TrustedPhones } from './TrustedPhones';

function phone(change: Partial<AnywhereTrustedPhone> = {}): AnywhereTrustedPhone {
  return {
    key: 'key-1',
    name: 'Runova app',
    platform: 'android',
    scopes: ['git'],
    approvedAt: Date.now() - 86_400_000,
    lastSeenAt: Date.now() - 3_600_000,
    connected: false,
    ...change,
  };
}

describe('the trusted phones list', () => {
  it('says so when no phone has been approved', () => {
    renderWithProviders(<TrustedPhones phones={[]} />);

    expect(screen.getByText(/No phone can manage this computer yet/)).toBeInTheDocument();
  });

  it('shows a phone that is connected right now', () => {
    renderWithProviders(<TrustedPhones phones={[phone({ connected: true })]} />);

    expect(screen.getByText('Runova app')).toBeInTheDocument();
    expect(screen.getByText('Connected now')).toBeInTheDocument();
  });

  it('switches what a phone may do', async () => {
    const { bridge } = renderWithProviders(<TrustedPhones phones={[phone()]} />);

    await userEvent.click(screen.getByRole('switch', { name: 'The Vault' }));

    expect(bridge.$fn('anywhere.setPhoneScopes')).toHaveBeenCalledWith('key-1', ['git', 'vault']);
  });

  it('forgets a phone only after asking', async () => {
    const { bridge } = renderWithProviders(<TrustedPhones phones={[phone()]} />);

    await userEvent.click(screen.getByRole('button', { name: 'Forget Runova app' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    await userEvent.click(screen.getByRole('button', { name: 'Forget Runova app' }));
    await userEvent.click(screen.getByRole('button', { name: 'Forget this phone' }));

    expect(bridge.$fn('anywhere.forgetPhone')).toHaveBeenCalledWith('key-1');
  });
});
