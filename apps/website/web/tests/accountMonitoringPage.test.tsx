// @vitest-environment jsdom
import './setup/dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveHandlers } from '../src/components/account/monitoring/live';
import Monitoring from '../src/components/account/monitoring/Monitoring';
import type { CloudMonitor, MonitorStatus, ScopeUsage } from '../src/lib/account/monitoring';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';

/** The Monitoring page (E57): the groups, the header line, live updates, the drawer and a Viewer. */

const hub = vi.hoisted(() => ({ handlers: null as LiveHandlers | null }));
vi.mock('../src/components/account/monitoring/live', () => ({
  connectMonitoringHub: (handlers: LiveHandlers) => {
    hub.handlers = handlers;
    handlers.state('live');
    return () => undefined;
  },
}));

function status(overrides: Partial<MonitorStatus> = {}): MonitorStatus {
  return {
    verdict: 'up',
    state: 'pass',
    lastCheckedAt: new Date(Date.now() - 60_000).toISOString(),
    latencyMs: 120,
    httpStatus: 200,
    problem: null,
    region: 'eu-central',
    confirming: false,
    openIncident: null,
    uptime24h: 0.999,
    ...overrides,
  };
}

function monitor(overrides: Partial<CloudMonitor> = {}): CloudMonitor {
  return {
    id: 1,
    scopeId: 10,
    itemId: 't-api',
    name: 'API',
    projectName: 'Storefront',
    environmentName: 'Production',
    url: 'https://api.example.com/health',
    intervalSec: 300,
    timeoutSec: 10,
    authMode: 'bearer',
    hasSecret: true,
    secretChangedAt: null,
    allowInsecure: false,
    paused: false,
    suspendedReason: null,
    notifyInApp: true,
    notifyTelegram: false,
    muted: false,
    canWrite: true,
    status: status(),
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    version: '7',
    ...overrides,
  };
}

const SCOPES: ScopeUsage[] = [
  {
    scopeId: 10,
    kind: 'personal',
    name: 'Personal',
    canWrite: true,
    accountTypeKey: 'go',
    accountTypeName: 'Go',
    maxMonitors: 10,
    minIntervalSec: 300,
    historyDays: 30,
    active: 1,
    paused: 0,
  },
  {
    scopeId: 20,
    kind: 'team',
    name: 'Platform',
    canWrite: false,
    accountTypeKey: 'pro',
    accountTypeName: 'Pro',
    maxMonitors: 50,
    minIntervalSec: 60,
    historyDays: 90,
    active: 1,
    paused: 0,
  },
  {
    scopeId: 30,
    kind: 'team',
    name: 'Growth',
    canWrite: true,
    accountTypeKey: 'free',
    accountTypeName: 'Free',
    maxMonitors: 1,
    minIntervalSec: 300,
    historyDays: 7,
    active: 1,
    paused: 0,
  },
];

const MONITORS = [
  monitor(),
  monitor({
    id: 2,
    scopeId: 20,
    name: 'Billing',
    projectName: 'Payments',
    environmentName: null,
    canWrite: false,
  }),
  monitor({ id: 3, scopeId: 30, name: 'Landing', projectName: 'Site', environmentName: null }),
];

function routes(monitors: CloudMonitor[] = MONITORS, extra: Parameters<typeof fakeFetch>[0] = {}) {
  return fakeFetch({
    'GET /api/v1/cloud-monitors': json({ items: monitors }),
    'GET /api/v1/cloud-monitors/usage': json({ scopes: SCOPES }),
    'GET /api/v1/cloud-monitors/1/hours*': json({ items: [] }),
    'GET /api/v1/cloud-monitors/2/hours*': json({ items: [] }),
    'GET /api/v1/cloud-monitors/3/hours*': json({ items: [] }),
    'GET /api/v1/cloud-monitors/1/samples': json({
      items: [
        {
          at: new Date(Date.now() - 120_000).toISOString(),
          state: 'pass',
          latencyMs: 100,
          httpStatus: 200,
          region: 'eu-central',
          problem: null,
        },
        {
          at: new Date(Date.now() - 60_000).toISOString(),
          state: 'pass',
          latencyMs: 140,
          httpStatus: 200,
          region: 'us-east',
          problem: null,
        },
      ],
    }),
    'GET /api/v1/cloud-monitors/2/samples': json({ items: [] }),
    'GET /api/v1/cloud-monitors/1/incidents?pageSize=20': json({
      items: [],
      page: 1,
      pageSize: 20,
      totalItems: 0,
      totalPages: 0,
    }),
    'GET /api/v1/cloud-monitors/2/incidents?pageSize=20': json({
      items: [],
      page: 1,
      pageSize: 20,
      totalItems: 0,
      totalPages: 0,
    }),
    ...extra,
  });
}

beforeEach(() => {
  document.cookie = 'XSRF-TOKEN=xsrf; path=/';
  hub.handlers = null;
});

describe('Monitoring', () => {
  it('shows the account its own monitors and both teams, each under its own name', async () => {
    routes();
    render(<Monitoring />);

    expect(await screen.findByRole('heading', { level: 2, name: 'Personal' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Platform' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Growth' })).toBeInTheDocument();
    expect(screen.getByText('All 3 monitors up')).toBeInTheDocument();
    expect(screen.getByText('Pro · 1 of 50 online · you can view')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Platform' }));
    expect(screen.queryByRole('heading', { level: 2, name: 'Personal' })).toBeNull();
    expect(screen.getByRole('article', { name: 'Billing' })).toBeInTheDocument();
  });

  it('moves a card the moment a result arrives from the hub', async () => {
    routes();
    render(<Monitoring />);
    const card = await screen.findByRole('article', { name: 'API' });
    expect(within(card).getByText('Up')).toBeInTheDocument();

    act(() =>
      hub.handlers?.updated({
        id: 1,
        scopeId: 10,
        itemId: 't-api',
        paused: false,
        status: status({
          verdict: 'down',
          state: 'unreachable',
          latencyMs: null,
          problem: 'Connection refused',
          region: 'us-east',
        }),
      }),
    );

    expect(within(card).getByText('Down')).toBeInTheDocument();
    expect(within(card).getByText('Connection refused')).toBeInTheDocument();
    expect(card).toHaveTextContent('from us-east');
    expect(screen.getByText('1 down')).toBeInTheDocument();
  });

  it('reads the list again when a scope changed', async () => {
    const fake = routes(MONITORS.slice(0, 1));
    render(<Monitoring />);
    await screen.findByRole('article', { name: 'API' });

    act(() => hub.handlers?.changed());

    await waitFor(() => expect(fake.calls('GET /api/v1/cloud-monitors').length).toBeGreaterThan(1));
  });

  it('pauses a monitor from its drawer with the version it was read at', async () => {
    const fake = routes(MONITORS, {
      'PATCH /api/v1/cloud-monitors/1': json({
        ...MONITORS[0],
        paused: true,
        version: '8',
        status: status({ verdict: 'paused' }),
      }),
    });
    const user = userEvent.setup();
    render(<Monitoring />);
    await user.click(await screen.findByRole('button', { name: 'Open API' }));
    const drawer = await screen.findByRole('dialog', { name: 'API' });
    expect(await within(drawer).findByText('us-east')).toBeInTheDocument();
    expect(within(drawer).getByRole('combobox', { name: /Check every/ })).toHaveValue('300');

    await user.click(within(drawer).getByRole('checkbox', { name: /Paused/ }));

    await waitFor(() => expect(fake.calls('PATCH /api/v1/cloud-monitors/1')).toHaveLength(1));
    const [patch] = fake.calls('PATCH /api/v1/cloud-monitors/1');
    expect(patch.headers.get('if-match')).toBe('"7"');
    expect(patch.json()).toEqual({ paused: true });
    expect(await within(drawer).findByRole('checkbox', { name: /Paused/ })).toBeChecked();
  });

  it('asks for a reload when someone changed it in between', async () => {
    routes(MONITORS, {
      'PATCH /api/v1/cloud-monitors/1': problem(412, 'precondition-failed', {
        currentVersion: '9',
      }),
    });
    const user = userEvent.setup();
    render(<Monitoring />);
    await user.click(await screen.findByRole('button', { name: 'Open API' }));
    const drawer = await screen.findByRole('dialog', { name: 'API' });

    await user.click(within(drawer).getByRole('checkbox', { name: /Alerts on Telegram/ }));

    expect(await within(drawer).findByText('Changed somewhere else')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Read it again' })).toBeInTheDocument();
  });

  it('shows a Viewer the settings read only, and says why', async () => {
    routes();
    const user = userEvent.setup();
    render(<Monitoring />);
    await user.click(await screen.findByRole('button', { name: 'Open Billing' }));
    const drawer = await screen.findByRole('dialog', { name: 'Billing' });

    expect(within(drawer).getByText('You can look, not change')).toBeInTheDocument();
    expect(within(drawer).getByText(/You are a Viewer of Platform/)).toBeInTheDocument();
    expect(within(drawer).getByRole('checkbox', { name: /Paused/ })).toBeDisabled();
    expect(within(drawer).getByRole('combobox', { name: /Check every/ })).toBeDisabled();
    // Muting is still theirs.
    expect(within(drawer).getByRole('checkbox', { name: /Mute for me/ })).toBeEnabled();
  });

  it('explains that monitors are made in the app when there are none', async () => {
    routes([]);
    render(<Monitoring />);

    expect(await screen.findByText('No online monitors yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get the app' })).toHaveAttribute('href', '/download');
  });
});
