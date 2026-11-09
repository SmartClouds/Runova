import type { EncryptionItem, EncryptionStatus } from '@shared/accountTypes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EncryptionPanel } from './EncryptionPanel';

const item = (change: Partial<EncryptionItem> = {}): EncryptionItem => ({
  item: 'notifications',
  label: 'Notifications',
  enabled: false,
  active: false,
  lapsed: false,
  needsKey: false,
  ...change,
});

const syncItem = (change: Partial<EncryptionItem> = {}) =>
  item({ item: 'sync', label: 'Cloud sync', ...change });

function status(change: Partial<EncryptionStatus> = {}): EncryptionStatus {
  return { entitled: true, planName: 'Pro', items: [item(), syncItem()], ...change };
}

const encryption = vi.fn<() => Promise<EncryptionStatus>>();
const setEncryption = vi.fn<(name: string, enabled: boolean) => Promise<EncryptionStatus>>();
const openWebsite = vi.fn<(path: string) => Promise<void>>();

function show(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EncryptionPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  encryption.mockReset();
  setEncryption.mockReset();
  openWebsite.mockReset();
  Object.assign(window, {
    runova: { account: { encryption, setEncryption, openWebsite } },
  });
});

describe('EncryptionPanel', () => {
  it('gives each item its own switch', async () => {
    encryption.mockResolvedValue(status());
    setEncryption.mockResolvedValue(status({ items: [item({ enabled: true }), syncItem()] }));
    show();

    fireEvent.click(await screen.findByRole('switch', { name: 'Notifications' }));

    await waitFor(() => expect(setEncryption).toHaveBeenCalledWith('notifications', true));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Notifications' })).toBeChecked(),
    );
    expect(screen.getByRole('switch', { name: 'Cloud sync' })).not.toBeChecked();
  });

  it('can be turned off without touching the other item', async () => {
    encryption.mockResolvedValue(
      status({ items: [item({ enabled: true }), syncItem({ enabled: true })] }),
    );
    setEncryption.mockResolvedValue(status({ items: [item(), syncItem({ enabled: true })] }));
    show();

    fireEvent.click(await screen.findByRole('switch', { name: 'Notifications' }));

    await waitFor(() => expect(setEncryption).toHaveBeenCalledWith('notifications', false));
    expect(setEncryption).toHaveBeenCalledTimes(1);
  });

  it('points to the plans when this plan does not include it', async () => {
    encryption.mockResolvedValue(status({ entitled: false, planName: 'Free' }));
    show();

    expect(await screen.findByRole('switch', { name: 'Notifications' })).toBeDisabled();
    expect(screen.getByText(/You are on Free/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'See plans' }));
    expect(openWebsite).toHaveBeenCalledWith('/pricing');
  });

  it('warns after a downgrade, and still lets it be turned off', async () => {
    encryption.mockResolvedValue(
      status({
        entitled: false,
        planName: 'Free',
        items: [item({ enabled: true, lapsed: true }), syncItem()],
      }),
    );
    show();

    expect(await screen.findByText(/no longer includes encryption/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Notifications' })).toBeEnabled();
    expect(screen.queryByText(/You are on Free/)).not.toBeInTheDocument();
  });

  it('asks for a key before sync can be sealed', async () => {
    encryption.mockResolvedValue(status({ items: [item(), syncItem({ needsKey: true })] }));
    show();

    expect(await screen.findByRole('switch', { name: 'Cloud sync' })).toBeDisabled();
    expect(screen.getByText(/Set a key/)).toBeInTheDocument();
  });

  it('is honest about what it does not cover', async () => {
    encryption.mockResolvedValue(status());
    show();

    expect(await screen.findByText(/uses TLS either way/)).toBeInTheDocument();
    expect(screen.getByText(/can't be sealed/)).toBeInTheDocument();
  });
});
