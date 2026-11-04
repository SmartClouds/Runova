import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SystemStatsSample } from '@/hooks/useSystemStatsHistory';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { NetworkSegment } from './NetworkSegment';

/**
 * The ping item in the status bar. It used to be a hover tooltip only, so the hosts and their
 * replies vanished the moment the pointer moved, and there was nowhere to see the machine's IP.
 * Now a click opens a panel the way CPU does, with the IP addresses and a way to look them up again.
 */

function sample(pings: SystemStatsSample['pings'], timestamp = 0): SystemStatsSample {
  return { timestamp, pings } as SystemStatsSample;
}

const HEALTHY = [
  sample([{ host: '1.1.1.1', alive: true, latencyMs: 31 }], 1),
  sample(
    [
      { host: '1.1.1.1', alive: true, latencyMs: 24.4 },
      { host: '8.8.8.8', alive: false, latencyMs: null },
    ],
    2,
  ),
];

const GERMANY = { ip: '203.0.113.9', country: 'Germany', countryCode: 'DE' };
const LAN = [{ name: 'Wi-Fi', address: '192.168.1.24' }];

function setup(bridge: Record<string, unknown> = {}, history = HEALTHY) {
  return renderWithProviders(<NetworkSegment history={history} />, {
    bridge: { 'ipGeo.lookup': GERMANY, 'remote.listInterfaces': LAN, ...bridge },
  });
}

async function openPanel(user: ReturnType<typeof setup>['user']): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Network' }));
  return screen.findByRole('dialog');
}

describe('the network status bar entry', () => {
  it('shows the best latency in the bar and looks nothing up until it is opened', () => {
    const { bridge } = setup();

    expect(
      within(screen.getByRole('button', { name: 'Network' })).getByText('24 ms'),
    ).toBeInTheDocument();
    expect(() => bridge.$fn('ipGeo.lookup')).toThrow();
  });

  it('opens on a click with every host pinged and how each answered', async () => {
    const { user } = setup();

    const panel = await openPanel(user);

    expect(within(panel).getByText('Ping 24 ms')).toBeInTheDocument();
    expect(within(panel).getByText('1.1.1.1')).toBeInTheDocument();
    expect(within(panel).getByText('8.8.8.8')).toBeInTheDocument();
    expect(within(panel).getByText('no reply')).toBeInTheDocument();
    expect(within(panel).getByText('67% of recent pings answered')).toBeInTheDocument();
  });

  it('shows the public IP with its country, and the local one with its adapter', async () => {
    const { user } = setup();

    const panel = await openPanel(user);

    expect(await within(panel).findByText('203.0.113.9')).toBeInTheDocument();
    expect(within(panel).getByText('Germany')).toBeInTheDocument();
    expect(within(panel).getByText('192.168.1.24')).toBeInTheDocument();
    expect(within(panel).getByText('Wi-Fi')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Copy public IP' })).toBeInTheDocument();
    expect(
      within(panel).getByRole('button', { name: 'Copy local IP 192.168.1.24' }),
    ).toBeInTheDocument();
  });

  it('opens without moving focus onto the refresh button', async () => {
    const { user } = setup();

    const panel = await openPanel(user);

    expect(within(panel).getByRole('button', { name: 'Refresh IP address' })).not.toHaveFocus();
  });

  it('looks the addresses up again past the cache when refresh is pressed', async () => {
    const { user, bridge } = setup();
    const panel = await openPanel(user);
    await within(panel).findByText('203.0.113.9');
    expect(bridge.$fn('ipGeo.lookup')).toHaveBeenCalledWith(false);

    bridge.$set('ipGeo.lookup', { ip: '198.51.100.4', country: 'Canada', countryCode: 'CA' });
    bridge.$set('remote.listInterfaces', [{ name: 'Ethernet', address: '10.0.0.7' }]);
    const refresh = within(panel).getByRole('button', { name: 'Refresh IP address' });
    await user.click(refresh);

    expect(refresh).toHaveAttribute('aria-busy', 'true');
    expect(await within(panel).findByText('198.51.100.4')).toBeInTheDocument();
    expect(within(panel).getByText('10.0.0.7')).toBeInTheDocument();
    expect(bridge.$fn('ipGeo.lookup')).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(refresh).toHaveAttribute('aria-busy', 'false'));
  });

  it('ignores a second press while a refresh runs', async () => {
    let finish!: (value: unknown) => void;
    const { user, bridge } = setup();
    const panel = await openPanel(user);
    await within(panel).findByText('203.0.113.9');
    bridge.$set(
      'ipGeo.lookup',
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = within(panel).getByRole('button', { name: 'Refresh IP address' });

    await user.click(refresh);
    await user.click(refresh);

    expect(bridge.$fn('ipGeo.lookup').mock.calls.filter(([force]) => force === true)).toHaveLength(
      1,
    );
    await act(async () => finish(GERMANY));
  });

  it('says so when the public address cannot be looked up, and keeps the local one', async () => {
    const { user } = setup({ 'ipGeo.lookup': () => Promise.reject(new Error('timed out')) });

    const panel = await openPanel(user);

    expect(await within(panel).findByText("Couldn't look it up")).toBeInTheDocument();
    expect(within(panel).getByText('192.168.1.24')).toBeInTheDocument();
  });

  it('says when no adapter has a local address', async () => {
    const { user } = setup({ 'remote.listInterfaces': [] });

    const panel = await openPanel(user);

    expect(await within(panel).findByText('No network adapter connected')).toBeInTheDocument();
  });
});
