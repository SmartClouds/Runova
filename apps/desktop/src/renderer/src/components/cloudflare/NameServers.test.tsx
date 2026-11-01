import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/** The name server list: one copy button each, and one for all of them. */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { NameServerList } = await import('./NameServers');

describe('NameServerList', () => {
  it('says "Copy all" for more than two, and shows when they were copied', async () => {
    const servers = ['a.ns.cloudflare.com', 'b.ns.cloudflare.com', 'c.ns.cloudflare.com'];
    const { user } = renderWithProviders(<NameServerList servers={servers} />);
    await user.click(screen.getByRole('button', { name: 'Copy all' }));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('has no copy-all button for a single server', () => {
    renderWithProviders(<NameServerList servers={['a.ns.cloudflare.com']} />);
    expect(screen.queryByRole('button', { name: /Copy (all|both)/ })).toBeNull();
  });

  it('says so when the clipboard refuses', async () => {
    const { user } = renderWithProviders(
      <NameServerList servers={['a.ns.cloudflare.com', 'b.ns.cloudflare.com']} />,
    );
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy both' }));
    expect(toast.error).toHaveBeenCalledWith('Could not copy that.');
    expect(screen.getByRole('button', { name: 'Copy both' })).toBeInTheDocument();
  });
});
