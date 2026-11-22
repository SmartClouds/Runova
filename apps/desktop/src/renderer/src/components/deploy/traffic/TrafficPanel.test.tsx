import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { OLDER_CORE, SERVER, signedIn, trafficBridge, trafficFake } from './testing/fixtures';

/**
 * A server's Traffic section (E109): the sign-in gate, an older core with its way out, statistics
 * off (with the switch for an Admin, words for everyone else), the full report with its filters,
 * live visitors and the site picker, and an empty range.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { TrafficPanel } = await import('./TrafficPanel');

function renderPanel(
  options: {
    roles?: string[];
    enabled?: boolean;
    empty?: boolean;
    bridge?: Record<string, unknown>;
    siteId?: string | null;
    onSiteChange?: (id: string | null) => void;
    onUpdateCore?: () => void;
    onOpenSection?: () => void;
  } = {},
) {
  const fake = trafficFake({ enabled: options.enabled ?? true, empty: options.empty ?? false });
  const view = renderWithProviders(
    <TrafficPanel
      server={SERVER}
      siteId={options.siteId ?? null}
      onSiteChange={options.onSiteChange ?? vi.fn()}
      {...(options.onUpdateCore ? { onUpdateCore: options.onUpdateCore } : {})}
      {...(options.onOpenSection ? { onOpenSection: options.onOpenSection } : {})}
    />,
    { bridge: { ...trafficBridge(fake, options.roles), ...options.bridge } },
  );
  return { ...view, fake };
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  confirm.mockClear();
});

describe('TrafficPanel', () => {
  it('asks to sign in first', async () => {
    renderPanel({ bridge: { 'deploy.access': async () => ({ state: 'signed-out' }) } });
    expect(await screen.findByText(/see how its websites are used/)).toBeInTheDocument();
  });

  it('shimmers while it reads the core', async () => {
    const { container } = renderPanel({
      bridge: { 'deployTraffic.status': () => new Promise(() => undefined) },
    });
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).not.toBeNull());
  });

  it('offers the core update on a core from before this feature', async () => {
    const onUpdateCore = vi.fn();
    const { user } = renderPanel({
      onUpdateCore,
      bridge: {
        'deployTraffic.status': async () => {
          throw new Error(OLDER_CORE);
        },
      },
    });
    expect(await screen.findByText(/older core without traffic statistics/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Update the core' }));
    expect(onUpdateCore).toHaveBeenCalledOnce();
  });

  it('says what failed and tries again', async () => {
    let fail = true;
    const { user, fake } = renderPanel({
      bridge: {
        'deployTraffic.status': async () => {
          if (fail) throw new Error('The connection dropped.');
          return fake.status();
        },
      },
    });
    expect(await screen.findByText('The connection dropped.')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('toolbar', { name: 'Report filters' })).toBeInTheDocument();
  });

  it('lets an Admin turn statistics on, reading what the logs already hold if asked', async () => {
    const { user, bridge } = renderPanel({ enabled: false, roles: ['admin'] });

    expect(await screen.findByText('Traffic statistics are off')).toBeInTheDocument();
    await user.click(screen.getByLabelText(/Also count what the logs already hold/));
    await user.click(screen.getByRole('button', { name: 'Turn on statistics' }));

    await waitFor(() =>
      expect(bridge.$fn('deployTraffic.saveSettings')).toHaveBeenCalledWith({
        serverId: SERVER.id,
        settings: expect.objectContaining({ enabled: true, readExistingLogs: true }),
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Traffic statistics are on/));
    expect(await screen.findByRole('toolbar', { name: 'Report filters' })).toBeInTheDocument();
  });

  it('tells a Viewer who can turn statistics on, and still shows the attacks', async () => {
    renderPanel({ enabled: false, roles: ['viewer'] });

    expect(
      await screen.findByText(/An Admin or Owner can turn traffic statistics on/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on statistics' })).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Security' })).toBeInTheDocument();
  });

  it('says why turning on did not work', async () => {
    const { user } = renderPanel({
      enabled: false,
      bridge: {
        'deployTraffic.saveSettings': async () => ({
          problems: ['Pick a time zone from the list.'],
          status: null,
        }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Turn on statistics' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Pick a time zone from the list.'),
    );
  });

  it('shows the report: tiles, chart, breakdowns, map, hours, responses and attacks', async () => {
    renderPanel();

    const visitors = await screen.findByRole('group', { name: 'Unique visitors' });
    expect(within(visitors).getByText('about')).toBeInTheDocument();
    expect(within(visitors).getByText(/vs the period before/)).toBeInTheDocument();
    for (const name of [
      'Visits',
      'Page views',
      'Bounce rate',
      'Pages per visit',
      'Visit length',
      'Bandwidth',
      'Bot share',
    ]) {
      expect(screen.getByRole('group', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { name: 'Visitors and page views' })).toBeInTheDocument();
    for (const title of [
      'Pages',
      'Entry pages',
      'Referrers',
      'Browsers',
      'Operating systems',
      'Status codes',
      'Bots',
      'Devices',
      'Busiest hours',
      'Responses',
      'Security',
      'Where visitors are',
    ]) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }
    expect(await screen.findByRole('img', { name: /World map of page views/ })).toBeInTheDocument();
    expect(screen.getByText(/82% from Cloudflare, 18% from DB-IP/)).toBeInTheDocument();
    expect(screen.getByText(/Unique visitors are estimates/)).toBeInTheDocument();
  });

  it('gives the cards in one row the same height, with "See all" at each foot', async () => {
    renderPanel();

    const row = (await screen.findByRole('heading', { name: 'Referrers' })).closest('section')!
      .parentElement!;
    // A grid stretches its items unless told otherwise; items-start left a thin card beside a tall one.
    expect(row).toHaveClass('grid');
    expect(row).not.toHaveClass('items-start');
    for (const title of ['Referrers', 'Browsers', 'Operating systems', 'Devices']) {
      const card = screen.getByRole('heading', { name: title }).closest('section')!;
      expect(card).toHaveClass('flex', 'flex-col');
      expect(card.lastElementChild).toHaveClass('flex-1');
    }
  });

  it('asks for a new report when the range, buckets or comparison change', async () => {
    const { user, bridge } = renderPanel();
    await screen.findByRole('group', { name: 'Unique visitors' });
    const report = bridge.$fn('deployTraffic.report');
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ granularity: 'day', compare: true }),
    );

    await user.click(screen.getByRole('radio', { name: 'Today' }));
    await waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ granularity: 'hour' })),
    );
    expect(screen.getByRole('radio', { name: 'Month' })).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: '12 months' }));
    await waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ granularity: 'month' })),
    );
    await user.click(screen.getByRole('radio', { name: 'Week' }));
    await waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ granularity: 'week' })),
    );

    await user.click(screen.getByRole('switch', { name: 'Compare with the period before' }));
    await waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ compare: false })),
    );
  });

  it('takes a custom range of days, refusing one that ends in the future', async () => {
    const { user, bridge } = renderPanel();
    await screen.findByRole('group', { name: 'Unique visitors' });

    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    const first = screen.getByLabelText('First day');
    const last = screen.getByLabelText('Last day');
    await user.clear(last);
    await user.type(last, '2999-01-01');
    expect(screen.getByText('The last day is in the future.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show' })).toBeDisabled();

    await user.clear(first);
    await user.type(first, '2026-01-01');
    await user.clear(last);
    await user.type(last, '2026-01-03');
    await user.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() =>
      expect(bridge.$fn('deployTraffic.report')).toHaveBeenLastCalledWith(
        expect.objectContaining({
          fromUnixMs: Date.UTC(2026, 0, 1),
          toUnixMs: Date.UTC(2026, 0, 4),
          granularity: 'day',
        }),
      ),
    );
  });

  it('shows live visitors as they come', async () => {
    const { bridge } = renderPanel();
    await screen.findByText('Waiting for live visitors');
    await waitFor(() => expect(bridge.$fn('deployTraffic.watchLive')).toHaveBeenCalled());

    bridge.$emit('deployTraffic.onLive', {
      subscriptionId: 'live-1',
      serverId: SERVER.id,
      siteId: null,
      live: { atUnixMs: 1, visitorsNow: 11, requestsLastMinute: 112, pagesNow: [] },
    });
    expect(await screen.findByText('11 visitors now')).toBeInTheDocument();
    bridge.$emit('deployTraffic.onLive', {
      subscriptionId: 'live-1',
      serverId: SERVER.id,
      siteId: null,
      ended: { error: 'gone' },
    });
    expect(await screen.findByText('Waiting for live visitors')).toBeInTheDocument();
  });

  it('picks a site, and reports on the one in the address', async () => {
    const onSiteChange = vi.fn();
    const { user, bridge } = renderPanel({ siteId: 'blog', onSiteChange });
    await screen.findByRole('group', { name: 'Unique visitors' });
    expect(bridge.$fn('deployTraffic.report')).toHaveBeenLastCalledWith(
      expect.objectContaining({ siteId: 'blog' }),
    );

    await user.click(screen.getByRole('combobox', { name: 'Website' }));
    await user.click(await screen.findByRole('option', { name: 'All websites' }));
    expect(onSiteChange).toHaveBeenCalledWith(null);
  });

  it('says so when nothing happened in the range', async () => {
    renderPanel({ empty: true });
    expect(await screen.findByText('No visits yet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Security' })).toBeInTheDocument();
  });

  it('offers the core update when the report itself is missing', async () => {
    renderPanel({
      onUpdateCore: vi.fn(),
      bridge: {
        'deployTraffic.report': async () => {
          throw new Error(OLDER_CORE);
        },
      },
    });
    expect(await screen.findByRole('button', { name: 'Update the core' })).toBeInTheDocument();
  });

  it('says what failed in the report and tries again', async () => {
    const { user, fake } = renderPanel({
      bridge: {
        'deployTraffic.report': vi
          .fn()
          .mockRejectedValueOnce(new Error('The report timed out.'))
          .mockImplementation(async ({ serverId: _, ...request }) => fake.report(request)),
      },
    });
    expect(await screen.findByText('The report timed out.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('group', { name: 'Unique visitors' })).toBeInTheDocument();
  });

  it('opens the settings and the Traffic section from a site’s tab', async () => {
    const onOpenSection = vi.fn();
    const { user } = renderPanel({ onOpenSection });
    await user.click(await screen.findByRole('button', { name: 'Open in Traffic' }));
    expect(onOpenSection).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Traffic settings' }));
    expect(await screen.findByRole('dialog', { name: 'Traffic settings' })).toBeInTheDocument();
    expect(signedIn).toBeDefined();
  });
});
