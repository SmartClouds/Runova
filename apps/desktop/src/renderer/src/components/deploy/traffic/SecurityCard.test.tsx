import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SERVER, trafficBridge, trafficFake } from './testing/fixtures';

/**
 * The Security card (E110 T7): attacks over the week by kind, the addresses behind them with what
 * they tried, blocking one after reading what that does, the blocked list with Unblock, and what a
 * Viewer may not do.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async (_options: Record<string, unknown>) => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { SecurityCard } = await import('./SecurityCard');

const SITES = new Map([
  ['blog', 'blog.example.com'],
  ['shop', 'shop.example.com'],
]);

function renderCard(
  options: {
    admin?: boolean;
    siteId?: string | null;
    detectionOn?: boolean;
    bridge?: Record<string, unknown>;
    onOpenSettings?: () => void;
    prepare?: (fake: ReturnType<typeof trafficFake>) => void;
  } = {},
) {
  const fake = trafficFake();
  options.prepare?.(fake);
  const view = renderWithProviders(
    <SecurityCard
      serverId={SERVER.id}
      siteId={options.siteId ?? null}
      admin={options.admin ?? true}
      detectionOn={options.detectionOn ?? true}
      timeZone="UTC"
      siteNames={SITES}
      {...(options.onOpenSettings ? { onOpenSettings: options.onOpenSettings } : {})}
    />,
    { bridge: { ...trafficBridge(fake), ...options.bridge } },
  );
  return { ...view, fake };
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  confirm.mockClear();
  confirm.mockImplementation(async () => true);
});

describe('SecurityCard', () => {
  it('charts the week by kind and lists who attacked, where and what they tried', async () => {
    renderCard();

    expect(
      await screen.findByRole('img', { name: /Attacks over the last 7 days/ }),
    ).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Recent attacks' });
    const scan = within(table).getByText('198.51.100.23').closest('tr') as HTMLElement;
    expect(within(scan).getByText('Scans')).toBeInTheDocument();
    expect(within(scan).getByText('on blog.example.com')).toBeInTheDocument();
    expect(within(scan).getByText('Netherlands')).toBeInTheDocument();
    expect(within(scan).getByText(/\/\.env/)).toBeInTheDocument();
    expect(screen.getByText('4 addresses')).toBeInTheDocument();
    expect(screen.getByText('No address is blocked.')).toBeInTheDocument();
  });

  it('blocks an address after showing what that does, then lists it', async () => {
    const { user, bridge } = renderCard();
    await user.click(await screen.findByRole('button', { name: 'Block 198.51.100.23' }));

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Block 198.51.100.23?',
        description: expect.stringMatching(
          /nginx will refuse 198\.51\.100\.23 on every site on this server/,
        ),
      }),
    );
    await waitFor(() =>
      expect(bridge.$fn('deployTraffic.block')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        network: '198.51.100.23',
        reason: 'Scans on blog.example.com',
        siteId: 'blog',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('198.51.100.23 is blocked on every site.');
    const blocked = await screen.findByRole('list', { name: 'Blocked addresses' });
    expect(within(blocked).getByText('198.51.100.23')).toBeInTheDocument();
    expect(within(blocked).getByText(/maria · For good/)).toBeInTheDocument();
    const row = within(screen.getByRole('table'))
      .getByText('198.51.100.23')
      .closest('tr') as HTMLElement;
    expect(within(row).getByText('Blocked')).toBeInTheDocument();
  });

  it('keeps the address when the block is cancelled, and says why one failed', async () => {
    const block = vi.fn(async () => ({ problems: ['That address is this app’s own.'] }));
    const { user } = renderCard({ bridge: { 'deployTraffic.block': block } });
    confirm.mockImplementationOnce(async () => false);
    await user.click(await screen.findByRole('button', { name: 'Block 203.0.113.45' }));
    expect(block).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Block 203.0.113.45' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That address is this app’s own.'),
    );
  });

  it('says when blocking failed outright', async () => {
    const { user } = renderCard({
      bridge: {
        'deployTraffic.block': async () => {
          throw new Error('nginx -t failed.');
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Block 192.0.2.77' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nginx -t failed.'));
  });

  it('lets an address back in after asking', async () => {
    const { user, bridge } = renderCard({
      prepare: (fake) => {
        fake.block({ network: '10.9.9.9', minutes: 60, reason: 'Floods on shop' });
        fake.blocks.push({
          id: 9,
          network: '10.8.8.8',
          reason: 'Scans on blog',
          automatic: true,
          createdAtUnixMs: Date.now(),
        });
      },
    });

    const list = await screen.findByRole('list', { name: 'Blocked addresses' });
    expect(within(list).getByText(/Automatic · For good/)).toBeInTheDocument();
    expect(within(list).getByText(/ends in/)).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Unblock 10.9.9.9' }));
    await waitFor(() =>
      expect(bridge.$fn('deployTraffic.unblock')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        blockId: 1,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('10.9.9.9 can reach the sites again.');
    await waitFor(() => expect(within(list).queryByText('10.9.9.9')).toBeNull());

    confirm.mockImplementationOnce(async () => false);
    await user.click(within(list).getByRole('button', { name: 'Unblock 10.8.8.8' }));
    expect(bridge.$fn('deployTraffic.unblock')).toHaveBeenCalledTimes(1);
  });

  it('says why an unblock failed', async () => {
    const { user } = renderCard({
      prepare: (fake) => fake.block({ network: '10.9.9.9' }),
      bridge: {
        'deployTraffic.unblock': async () => {
          throw new Error('That address is not blocked any more.');
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Unblock 10.9.9.9' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That address is not blocked any more.'),
    );
  });

  it('shows a Viewer the attacks without Block, Unblock or the settings', async () => {
    renderCard({
      admin: false,
      siteId: 'blog',
      onOpenSettings: vi.fn(),
      prepare: (fake) => fake.block({ network: '10.9.9.9' }),
    });

    const table = await screen.findByRole('table', { name: 'Recent attacks' });
    expect(within(table).queryByRole('button')).toBeNull();
    expect(within(table).queryByText(/on blog/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Detection settings/ })).toBeNull();
  });

  it('opens the detection settings for an Admin, and says when detection is off', async () => {
    const onOpenSettings = vi.fn();
    const { user } = renderCard({ detectionOn: false, onOpenSettings });
    expect(screen.getByText(/Attack detection is off/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Detection settings/ }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('says when there were no attacks, and when they did not load', async () => {
    renderCard({
      bridge: {
        'deployTraffic.attacks': async () => ({ events: [], series: [], addresses: 0, blocked: 0 }),
      },
    });
    expect(await screen.findByText('No attacks in the last 7 days.')).toBeInTheDocument();
  });

  it('says what failed when the attacks did not load', async () => {
    renderCard({
      bridge: {
        'deployTraffic.attacks': async () => {
          throw new Error('The attack log is busy.');
        },
      },
    });
    expect(await screen.findByText('The attack log is busy.')).toBeInTheDocument();
  });
});
