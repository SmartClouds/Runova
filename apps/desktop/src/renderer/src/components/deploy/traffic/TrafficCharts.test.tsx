import type { TrafficReport } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { fakeTrafficReport } from '@shared/deploy/testing/fakeTraffic';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { BreakdownCard } from './BreakdownCard';
import { CountriesCard } from './CountriesCard';
import { DevicesCard } from './DevicesCard';
import { HourHeatmap } from './HourHeatmap';
import { KpiTiles } from './KpiTiles';
import { ResponseCard } from './ResponseCard';
import { TimeChart } from './TimeChart';
import { TrafficChartCard } from './TrafficChartCard';
import { SERVER, trafficBridge, trafficFake } from './testing/fixtures';

/**
 * The report's cards (E109) one by one: values reachable without a pointer (keyboard readouts and
 * table views), the period before, the map and its list, "See all" with its search and pages.
 */

const DAY = 86_400_000;
const TO = Date.UTC(2026, 10, 18, 14);
const REPORT: TrafficReport = fakeTrafficReport({
  fromUnixMs: TO - 7 * DAY,
  toUnixMs: TO,
  granularity: 'day',
  compare: true,
});
const RANGE = { fromUnixMs: REPORT.fromUnixMs, toUnixMs: REPORT.toUnixMs };

describe('TimeChart', () => {
  const props = {
    title: 'Visitors',
    times: [0, 1, 2],
    series: [{ key: 'v', label: 'Visitors', color: 'red', values: [1, 5, 3], previous: [2, 2, 2] }],
    formatValue: (value: number) => String(value),
    formatTick: (value: number) => String(value),
    bucketLabel: (at: number) => `bucket ${at}`,
    axisLabel: (at: number) => `axis ${at}`,
    previousLabel: 'Period before',
  };

  it('reads each bucket with the arrow keys, the period before included', async () => {
    const { user, container } = renderWithProviders(<TimeChart {...props} />);
    const chart = screen.getByRole('img', { name: /3 buckets from bucket 0 to bucket 2/ });
    expect(container.querySelector('[data-previous="v"]')).not.toBeNull();

    chart.focus();
    await user.keyboard('{ArrowLeft}');
    const tooltip = screen.getByRole('tooltip');
    expect(within(tooltip).getByText('bucket 1')).toBeInTheDocument();
    expect(within(tooltip).getByText('5')).toBeInTheDocument();
    expect(within(tooltip).getByText('(2 period before)')).toBeInTheDocument();
    await user.keyboard('{Home}');
    expect(within(screen.getByRole('tooltip')).getByText('bucket 0')).toBeInTheDocument();
    await user.keyboard('{End}{ArrowRight}');
    expect(within(screen.getByRole('tooltip')).getByText('bucket 2')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.keyboard('x');
  });

  it('follows the pointer and says when there is nothing', () => {
    const { rerender } = renderWithProviders(<TimeChart {...props} />);
    const chart = screen.getByRole('img', { name: /Visitors, 3 buckets/ });
    fireEvent.pointerMove(chart, { clientX: 0 });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.pointerLeave(chart);
    expect(screen.queryByRole('tooltip')).toBeNull();
    rerender(<TimeChart {...props} times={[]} series={[]} />);
    expect(
      screen.getByRole('img', { name: 'Visitors: nothing in this range' }),
    ).toBeInTheDocument();
  });
});

describe('TrafficChartCard', () => {
  it('turns into a table with the period before, and back', async () => {
    const { user } = renderWithProviders(<TrafficChartCard report={REPORT} />);
    expect(screen.getByText('Period before')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Table' }));
    const table = screen.getByRole('table', { name: 'Visitors and page views' });
    expect(within(table).getByText('Page views before')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(REPORT.series.length + 1);
    await user.click(screen.getByRole('button', { name: 'Chart' }));
    expect(
      screen.getByRole('img', { name: /Visitors and page views, 8 buckets/ }),
    ).toBeInTheDocument();
  });
});

describe('the period before', () => {
  it('says there is no earlier data, and draws no dashed line, before statistics were on', () => {
    const fresh = { ...REPORT, collectingSinceUnixMs: REPORT.fromUnixMs + DAY };
    const { container } = renderWithProviders(
      <>
        <KpiTiles report={fresh} />
        <TrafficChartCard report={fresh} />
      </>,
    );
    expect(screen.getAllByText('No earlier data')).toHaveLength(8);
    expect(screen.queryByText(/vs the period before/)).toBeNull();
    expect(container.querySelector('[data-previous]')).toBeNull();
    expect(screen.queryByText('Period before')).toBeNull();
  });

  it('draws the period before only from when it was counted', async () => {
    const starts = REPORT.previousSeries?.map((point) => point.startUnixMs) ?? [];
    const partial = { ...REPORT, collectingSinceUnixMs: starts[4] };
    const { container, user } = renderWithProviders(<TrafficChartCard report={partial} />);
    const dashed = container.querySelector('[data-previous="pageViews"]')?.getAttribute('d') ?? '';
    expect(dashed.startsWith('M')).toBe(true);
    expect(dashed.match(/M/g)).toHaveLength(1);
    expect(dashed.match(/L/g)).toHaveLength(REPORT.series.length - 5);
    await user.click(screen.getByRole('button', { name: 'Table' }));
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(
      within(rows.at(-1) as HTMLElement)
        .getAllByRole('cell')
        .at(-1)?.textContent,
    ).toBe('');
  });
});

describe('KpiTiles', () => {
  it('marks a falling bounce rate as good news and a rise in visitors too', () => {
    const report = {
      ...REPORT,
      previous: { ...REPORT.totals, bounces: REPORT.totals.bounces * 2, visitors: 1 },
    };
    const { container } = renderWithProviders(<KpiTiles report={report} />);
    const bounce = container.querySelector('[data-kpi="bounceRate"]');
    expect(bounce?.querySelector('.text-success')?.textContent).toMatch(/-50%/);
    const visitors = container.querySelector('[data-kpi="visitors"]');
    expect(visitors?.querySelector('.text-success')).not.toBeNull();
    expect(container.querySelectorAll('svg path').length).toBeGreaterThan(3);
  });
});

describe('BreakdownCard', () => {
  it('shows the top rows and pages through all of them with a search', async () => {
    const fake = trafficFake();
    const { user, bridge } = renderWithProviders(
      <BreakdownCard
        serverId={SERVER.id}
        siteId="blog"
        range={RANGE}
        breakdown={REPORT.breakdowns.find((item) => item.dimension === 'page')!}
        icon={null}
      />,
      { bridge: trafficBridge(fake) },
    );
    const list = screen.getByRole('list', { name: 'Pages' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(8);

    await user.click(screen.getByRole('button', { name: 'See all' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pages' });
    expect(await within(dialog).findByText('1 to 50 of 90')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Next/ }));
    expect(await within(dialog).findByText('51 to 90 of 90')).toBeInTheDocument();
    // The search box waiting to settle must not send the page back to the first one.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(within(dialog).getByText('51 to 90 of 90')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Back/ }));
    expect(await within(dialog).findByText('1 to 50 of 90')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Search pages'), 'pricing');
    await waitFor(() =>
      expect(bridge.$fn('deployTraffic.dimension')).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'pricing', offset: 0, siteId: 'blog', limit: 50 }),
      ),
    );
    expect(await within(dialog).findByText('/pricing')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Search pages'));
    await user.type(within(dialog).getByLabelText('Search pages'), 'zzz');
    expect(await within(dialog).findByText('Nothing matches “zzz”.')).toBeInTheDocument();
  });

  it('says when a breakdown is empty or its page failed', async () => {
    const { user } = renderWithProviders(
      <>
        <BreakdownCard
          serverId={SERVER.id}
          siteId={null}
          range={RANGE}
          breakdown={{ dimension: 'bot', top: [], total: 0 }}
          icon={null}
        />
        <BreakdownCard
          serverId={SERVER.id}
          siteId={null}
          range={RANGE}
          breakdown={REPORT.breakdowns.find((item) => item.dimension === 'statusCode')!}
          icon={null}
        />
      </>,
      {
        bridge: {
          'deployTraffic.dimension': async () => {
            throw new Error('The core is busy.');
          },
        },
      },
    );
    expect(screen.getByText('Nothing in this range.')).toBeInTheDocument();
    expect(screen.getByText('Not found')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'See all' }));
    expect(await screen.findByText('The core is busy.')).toBeInTheDocument();
  });
});

describe('DevicesCard', () => {
  it('draws a ring with every device named and its share, lifting the one pointed at', async () => {
    const breakdown = REPORT.breakdowns.find((item) => item.dimension === 'device')!;
    const { user, container } = renderWithProviders(<DevicesCard breakdown={breakdown} />);
    expect(
      screen.getByRole('img', { name: /Devices: Desktop 61%, Mobile 34%, Tablet 5%/ }),
    ).toBeInTheDocument();
    await user.hover(screen.getByRole('button', { name: /Mobile/ }));
    expect(container.querySelector('text')?.textContent).toBe('34%');
    await user.unhover(screen.getByRole('button', { name: /Mobile/ }));
    expect(container.querySelector('text')?.textContent).toMatch(/K$/);
    const ring = container.querySelectorAll('svg[aria-label^="Devices:"] path');
    await user.hover(ring[0]);
    expect(container.querySelector('text')?.textContent).toBe('61%');
    await user.unhover(ring[0]);
  });

  it('says when there is nothing to show', () => {
    renderWithProviders(<DevicesCard breakdown={{ dimension: 'device', top: [], total: 0 }} />);
    expect(screen.getByText('Nothing in this range.')).toBeInTheDocument();
  });
});

describe('HourHeatmap', () => {
  it('names the busiest hour and walks the week with the arrow keys', async () => {
    const values = Array.from({ length: 168 }, (_, i) => (i === 26 ? 90 : i % 5));
    const { user } = renderWithProviders(<HourHeatmap values={values} timeZone="UTC" />);
    expect(screen.getByText('Busiest: Tuesday around 02:00')).toBeInTheDocument();
    screen.getByRole('grid').focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByText('Tuesday 03:00 to 04:00: 2 page views')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{ArrowUp}{ArrowUp}{ArrowLeft}');
    expect(screen.getByText('Monday 02:00 to 03:00: 2 page views')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByText('Busiest: Tuesday around 02:00')).toBeInTheDocument();
  });

  it('says when nothing came', () => {
    renderWithProviders(<HourHeatmap values={[]} timeZone="UTC" />);
    expect(screen.getByText('No page views in this range.')).toBeInTheDocument();
  });
});

describe('ResponseCard', () => {
  it('gives the response times and the status mix, walkable by key', async () => {
    const { user } = renderWithProviders(<ResponseCard report={REPORT} />);
    expect(screen.getByText('39 ms')).toBeInTheDocument();
    expect(screen.getByText('212 ms')).toBeInTheDocument();
    const chart = screen.getByRole('img', { name: /Requests by status, 8 buckets/ });
    chart.focus();
    await user.keyboard('{ArrowLeft}');
    expect(
      within(screen.getByRole('tooltip')).getByText('Client errors (4xx)'),
    ).toBeInTheDocument();
    await user.keyboard('{Home}{End}{ArrowRight}{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.pointerEnter(chart.querySelectorAll('[data-column]')[0]);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.pointerLeave(chart);
  });
});

describe('CountriesCard', () => {
  it('draws the map, lists countries with flags, switches to cities and credits DB-IP', async () => {
    // Unknown has the most page views here, yet ranks last.
    const withUnknown = {
      ...REPORT,
      breakdowns: REPORT.breakdowns.map((item) =>
        item.dimension === 'country'
          ? {
              ...item,
              top: [{ value: 'XX', count: 9000 }, ...item.top.filter((c) => c.value !== 'XX')],
            }
          : item,
      ),
    };
    const { user, bridge, container } = renderWithProviders(
      <CountriesCard serverId={SERVER.id} report={withUnknown} countriesOn />,
      { bridge: { 'shell.openExternal': async () => undefined } },
    );
    const map = await screen.findByRole('img', {
      name: /World map of page views by country, 12 countries/,
    });
    const countries = screen.getByRole('list', { name: 'Countries' });
    expect(within(countries).getByText('United States')).toBeInTheDocument();
    expect(within(countries).queryByText('T1')).toBeNull();
    // Unknown is counted but never leads the list.
    const names = within(countries)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    expect(names[0]).toMatch(/United States/);
    expect(names.at(-1)).toMatch(/Unknown/);

    fireEvent.pointerOver(within(countries).getByText('Germany'));
    expect(map.querySelectorAll('path[stroke-width="1.2"]')).toHaveLength(1);
    fireEvent.pointerLeave(countries.parentElement as HTMLElement);

    fireEvent.pointerMove(map.querySelectorAll('path')[0], { clientX: 5, clientY: 5 });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.pointerLeave(map);

    await user.click(screen.getByRole('button', { name: 'Cities' }));
    const cities = screen.getByRole('list', { name: 'Cities' });
    // The core writes cities as "City, CC": the city shows with its country's flag and name.
    expect(within(cities).getByText('Berlin')).toBeInTheDocument();
    expect(within(cities).getByText('Germany')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /IP geolocation by DB-IP/ }));
    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith('https://db-ip.com');
    expect(container.textContent).toMatch(/CC BY 4.0/);
  });

  it('says countries are off', () => {
    renderWithProviders(<CountriesCard serverId={SERVER.id} report={REPORT} countriesOn={false} />);
    expect(screen.getByText('Countries are turned off in the settings.')).toBeInTheDocument();
  });
});
