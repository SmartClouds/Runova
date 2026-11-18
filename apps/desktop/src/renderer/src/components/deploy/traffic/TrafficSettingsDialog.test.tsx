import { encodeCoreError } from '@shared/coreErrors';
import type { FakeTraffic } from '@shared/deploy/testing/fakeTraffic';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import type { SettingsTab } from './TrafficSettingsDialog';
import { GEOLOCATION, SERVER, trafficBridge, trafficFake, ZONE_ID } from './testing/fixtures';

/**
 * The Traffic settings (E109, E110): statistics with the core's limits, the sites counted and the
 * note on sites that log nothing, detection thresholds and the allowlist, auto-block (an Owner's,
 * after a step-up), deleting statistics, and Cloudflare's visitor location per site.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async (_options: Record<string, unknown>) => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { TrafficSettingsDialog } = await import('./TrafficSettingsDialog');

function renderDialog(
  options: {
    admin?: boolean;
    owner?: boolean;
    tab?: SettingsTab;
    siteId?: string | null;
    bridge?: Record<string, unknown>;
    prepare?: (fake: FakeTraffic) => void;
  } = {},
) {
  const fake = trafficFake();
  options.prepare?.(fake);
  const onClose = vi.fn();
  const view = renderWithProviders(
    <TrafficSettingsDialog
      server={SERVER}
      status={fake.status()}
      admin={options.admin ?? true}
      owner={options.owner ?? true}
      siteId={options.siteId === undefined ? 'blog' : options.siteId}
      initialTab={options.tab ?? 'statistics'}
      onClose={onClose}
    />,
    { bridge: { ...trafficBridge(fake), ...options.bridge } },
  );
  return { ...view, fake, onClose };
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  confirm.mockClear();
  confirm.mockImplementation(async () => true);
});

describe('TrafficSettingsDialog statistics', () => {
  it('shows the core’s limits as problems and saves the settings once they hold', async () => {
    const { user, bridge, fake } = renderDialog();
    const hourly = screen.getByLabelText('Keep hourly figures (days)');
    await user.clear(hourly);
    await user.type(hourly, '3');
    await user.click(screen.getByRole('button', { name: 'Save statistics' }));
    expect(await screen.findByText('Keep hourly figures for 7 to 365 days.')).toBeInTheDocument();

    await user.clear(hourly);
    await user.type(hourly, '30x');
    await user.click(screen.getByRole('checkbox', { name: 'shop.example.com' }));
    await user.click(screen.getByRole('switch', { name: 'Countries' }));
    await user.click(screen.getByRole('button', { name: 'Save statistics' }));

    await waitFor(() =>
      expect(bridge.$fn('deployTraffic.saveSettings')).toHaveBeenLastCalledWith({
        serverId: SERVER.id,
        settings: expect.objectContaining({
          hourlyRetentionDays: 30,
          excludedSites: ['shop'],
          countries: false,
          readExistingLogs: false,
        }),
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Traffic statistics saved.');
    expect(fake.settings.excludedSites).toEqual(['shop']);
    expect(screen.queryByText('Keep hourly figures for 7 to 365 days.')).toBeNull();
  });

  it('turns statistics off and on again, with the old logs read when asked', async () => {
    const { user, bridge } = renderDialog({
      prepare: (fake) => {
        fake.settings.enabled = false;
        fake.loggingOff.add('shop');
      },
    });
    expect(screen.getByText(/shop\.example\.com has a snippet that turns/)).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Count traffic' }));
    await user.click(screen.getByLabelText(/Also count what the logs already hold/));
    await user.click(screen.getByRole('button', { name: 'Save statistics' }));
    await waitFor(() =>
      expect(bridge.$fn('deployTraffic.saveSettings')).toHaveBeenLastCalledWith({
        serverId: SERVER.id,
        settings: expect.objectContaining({ enabled: true, readExistingLogs: true }),
      }),
    );
  });

  it('picks the time zone from the list, the server’s marked', async () => {
    const { user, bridge } = renderDialog();
    await user.click(screen.getByRole('combobox', { name: 'Time zone' }));
    await user.type(await screen.findByPlaceholderText('Search time zones'), 'Berlin');
    await user.click(await screen.findByRole('option', { name: 'Europe/Berlin' }));
    await user.click(screen.getByRole('button', { name: 'Save statistics' }));
    await waitFor(() =>
      expect(bridge.$fn('deployTraffic.saveSettings')).toHaveBeenLastCalledWith({
        serverId: SERVER.id,
        settings: expect.objectContaining({ timeZone: 'Europe/Berlin' }),
      }),
    );
  });

  it('says when saving failed outright', async () => {
    const { user } = renderDialog({
      bridge: {
        'deployTraffic.saveSettings': async () => {
          throw new Error('The core went away.');
        },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Save statistics' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The core went away.'));
  });

  it('deletes one site’s statistics or every site’s, after asking', async () => {
    const { user, bridge, fake } = renderDialog();
    await user.click(screen.getByRole('button', { name: /Delete this site's/ }));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Delete the statistics of blog?' }),
    );
    await waitFor(() => expect(fake.deleted).toEqual(['blog']));
    expect(toast.success).toHaveBeenCalledWith('Statistics deleted.');

    confirm.mockImplementationOnce(async () => false);
    await user.click(screen.getByRole('button', { name: /Delete every site's/ }));
    expect(bridge.$fn('deployTraffic.deleteData')).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /Delete every site's/ }));
    await waitFor(() => expect(fake.deleted).toEqual(['blog', '*']));
  });

  it('shows a Viewer the settings without letting them change anything', () => {
    renderDialog({ admin: false, owner: false, siteId: null });
    expect(screen.getByRole('switch', { name: 'Count traffic' })).toBeDisabled();
    expect(screen.getByLabelText('Keep daily figures (days)')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save statistics' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(screen.getByText(/An Admin or Owner can change it/)).toBeInTheDocument();
  });

  it('closes', async () => {
    const { user, onClose } = renderDialog();
    for (const close of screen.getAllByRole('button', { name: 'Close' })) await user.click(close);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('TrafficSettingsDialog detection', () => {
  it('saves thresholds and the allowlist, one entry a line', async () => {
    const { user, bridge, fake } = renderDialog({ tab: 'detection' });
    const probes = screen.getByLabelText('Probe paths');
    await user.clear(probes);
    await user.type(probes, '40');
    await user.type(screen.getByLabelText(/Never flag or block/), '203.0.113.7\n10.0.0.0/8');
    await user.click(screen.getByRole('switch', { name: 'Watch for attacks' }));
    await user.click(screen.getByRole('button', { name: 'Save detection' }));

    await waitFor(() =>
      expect(bridge.$fn('deployTraffic.saveAttackSettings')).toHaveBeenLastCalledWith({
        serverId: SERVER.id,
        settings: expect.objectContaining({
          enabled: false,
          allowlist: ['203.0.113.7', '10.0.0.0/8'],
          thresholds: expect.objectContaining({ scanProbes: 40, floodRequestsPerMinute: 600 }),
        }),
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Attack detection is off.');
    expect(fake.attackSettings.thresholds.scanProbes).toBe(40);
  });

  it('names an allowlist entry that is not an address', async () => {
    const { user } = renderDialog({ tab: 'detection' });
    await user.type(screen.getByLabelText(/Never flag or block/), 'my-laptop');
    await user.click(screen.getByRole('button', { name: 'Save detection' }));
    expect(await screen.findByText(/my-laptop: write an address/)).toBeInTheDocument();
  });
});

describe('TrafficSettingsDialog auto-block', () => {
  it('lets an Owner turn it on after a step-up', async () => {
    let calls = 0;
    const { user, bridge, fake } = renderDialog({
      tab: 'autoBlock',
      bridge: {
        'deploy.stepUpSaved': async () => false,
        'deployTraffic.saveAutoBlock': vi.fn(async ({ settings }) => {
          calls += 1;
          if (calls === 1)
            throw new Error(encodeCoreError('stepUpRequired', 'Needs your password.'));
          const result = fake.saveAutoBlock(settings);
          return { problems: result.problems, status: result.status ?? null };
        }),
      },
    });
    await user.click(screen.getByRole('switch', { name: 'Block attackers by itself' }));
    await user.click(screen.getByRole('checkbox', { name: 'Floods' }));
    await user.click(screen.getByRole('checkbox', { name: 'Scans' }));
    const minutes = screen.getByLabelText('Block for (minutes)');
    await user.clear(minutes);
    await user.type(minutes, '0');
    await user.click(screen.getByRole('button', { name: 'Save auto-block' }));
    await user.type(await screen.findByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(bridge.$fn('deployTraffic.saveAutoBlock')).toHaveBeenLastCalledWith({
        serverId: SERVER.id,
        settings: { enabled: true, kinds: ['bruteForce', 'flood'], minutes: 0, maxBlocked: 1000 },
        password: 'secret',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Auto-block is on.');
    expect(fake.autoBlock.enabled).toBe(true);
  });

  it('shows what the core refused', async () => {
    const { user } = renderDialog({ tab: 'autoBlock' });
    await user.click(screen.getByRole('switch', { name: 'Block attackers by itself' }));
    await user.click(screen.getByRole('checkbox', { name: 'Scans' }));
    await user.click(screen.getByRole('checkbox', { name: 'Password guessing' }));
    await user.click(screen.getByRole('button', { name: 'Save auto-block' }));
    expect(
      await screen.findByText('Pick at least one kind of attack to block.'),
    ).toBeInTheDocument();
  });

  it('tells an Admin that only an Owner can change it', () => {
    renderDialog({ tab: 'autoBlock', owner: false });
    expect(screen.getByText(/Only an Owner can change auto-block/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Block attackers by itself' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save auto-block' })).toBeNull();
  });
});

describe('TrafficSettingsDialog Cloudflare', () => {
  it('shows each site’s visitor location and turns it on for a zone', async () => {
    const { user, bridge } = renderDialog({ tab: 'cloudflare' });
    const list = await screen.findByRole('list', { name: 'Cloudflare visitor location by site' });
    expect(within(list).getByText('Country: on')).toBeInTheDocument();
    expect(within(list).getByText('City and region: off')).toBeInTheDocument();
    expect(within(list).getByText('Not on a Cloudflare zone you connected')).toBeInTheDocument();

    await user.click(
      within(list).getByRole('button', { name: /Turn on visitor location for blog/ }),
    );
    await waitFor(() =>
      expect(bridge.$fn('deployTraffic.turnOnGeolocation')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        zoneId: ZONE_ID,
      }),
    );
    expect(await within(list).findByText('City and region: on')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/example\.com/));
  });

  it('says what Cloudflare refused', async () => {
    const { user } = renderDialog({
      tab: 'cloudflare',
      bridge: {
        'deployTraffic.geolocation': async () => ({
          ...GEOLOCATION,
          sites: [
            {
              ...GEOLOCATION.sites[0],
              locationHeaders: null,
              problem: 'Add Zone > Transform Rules > Edit.',
            },
          ],
        }),
        'deployTraffic.turnOnGeolocation': async () => {
          throw new Error('This token is not allowed to turn on the visitor location headers.');
        },
      },
    });
    expect(await screen.findByText('Add Zone > Transform Rules > Edit.')).toBeInTheDocument();
    expect(screen.getByText('City and region: unknown')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Turn on visitor location/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'This token is not allowed to turn on the visitor location headers.',
      ),
    );
  });

  it('asks to connect Cloudflare, and says when it could not be read', async () => {
    renderDialog({
      tab: 'cloudflare',
      bridge: { 'deployTraffic.geolocation': async () => ({ connected: false, sites: [] }) },
    });
    expect(await screen.findByText(/Connect a Cloudflare account/)).toBeInTheDocument();
  });

  it('says when Cloudflare could not be reached', async () => {
    renderDialog({
      tab: 'cloudflare',
      bridge: {
        'deployTraffic.geolocation': async () => {
          throw new Error('Cloudflare did not answer.');
        },
      },
    });
    expect(await screen.findByText('Cloudflare did not answer.')).toBeInTheDocument();
  });
});
