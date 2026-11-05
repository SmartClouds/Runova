// @vitest-environment jsdom
import './setup/dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import ReportsView, { actionLabel, actorLabel } from '../src/components/admin/ReportsView';
import {
  bucketDays,
  type DailyCount,
  formatBytes,
  formatDay,
  percentOf,
  platformName,
  type Report,
  readPeriod,
  versionName,
} from '../src/lib/admin/reports';
import { page } from './fixtures/admin/staff';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';

/** `days` days ending 2026-11-06, each with the count `count(index)`. */
function daysEnding(days: number, count: (index: number) => number = () => 0): DailyCount[] {
  const end = Date.UTC(2026, 10, 6);
  return Array.from({ length: days }, (_, index) => ({
    date: new Date(end - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10),
    count: count(index),
  }));
}

const REPORT: Report = {
  generatedAt: '2026-11-06T12:00:00.000Z',
  days: 30,
  users: {
    total: 1240,
    accounts: 1230,
    admins: 2,
    editors: 8,
    disabled: 3,
    unconfirmed: 17,
    twoFactor: 310,
    joined: 96,
    active: 620,
  },
  signUps: daysEnding(30, (index) => (index === 29 ? 9 : index % 3)),
  newestUsers: [
    {
      id: 1240,
      displayName: 'Ada Account',
      email: 'ada@example.com',
      staff: false,
      createdAt: '2026-11-06T08:00:00.000Z',
    },
    {
      id: 1239,
      displayName: 'Eda Editor',
      email: 'eda@runovahq.com',
      staff: true,
      createdAt: '2026-11-05T08:00:00.000Z',
    },
  ],
  sessions: {
    web: 410,
    desktop: 380,
    platforms: [
      { name: 'windows', count: 240 },
      { name: 'macos', count: 100 },
      { name: 'linux', count: 40 },
    ],
    appVersions: [
      { name: '3.3.0', count: 300 },
      { name: '', count: 80 },
    ],
  },
  teams: { total: 42, members: 150, pendingInvitations: 6 },
  sync: { scopes: 1100, items: 52_000, bytes: 3 * 1024 * 1024 * 1024 },
  content: {
    newsPublished: 48,
    newsScheduled: 1,
    newsDrafts: 3,
    postsPublished: 12,
    postsScheduled: 0,
    postsDrafts: 2,
    media: 30,
  },
  apiClients: { active: 2, inactive: 1 },
  latestRelease: '3.3.0',
};

const ENTRIES = [
  {
    id: 90,
    at: '2026-11-06T09:00:00.000Z',
    actorKind: 'user',
    actorId: 1,
    action: 'news.publish',
    targetType: 'news',
    targetId: '48',
    ip: null,
  },
  {
    id: 89,
    at: '2026-11-06T08:00:00.000Z',
    actorKind: 'system',
    actorId: null,
    action: 'user.invite',
    targetType: 'user',
    targetId: '2',
    ip: null,
  },
  {
    id: 88,
    at: '2026-11-05T08:00:00.000Z',
    actorKind: 'api-client',
    actorId: 3,
    action: 'media.upload',
    targetType: 'media',
    targetId: '30',
    ip: null,
  },
];

const ACTIVITY = 'GET /api/v1/audit-entries?page=1&pageSize=10';

/** The number a tile shows under its label. */
const tile = (label: string) => {
  const term = screen.getByText(label, { selector: 'dt, dt a' }).closest('dt') as HTMLElement;
  return term.nextElementSibling?.textContent;
};

beforeEach(() => {
  window.history.replaceState(null, '', '/admin/reports');
});

describe('ReportsView', () => {
  it('shows the user counts for the last 30 days by default', async () => {
    const api = fakeFetch({
      'GET /api/v1/reports/current?days=30': json(REPORT),
      [ACTIVITY]: json(page(ENTRIES)),
    });
    render(<ReportsView />);

    expect(await screen.findByRole('heading', { level: 2, name: 'Users' })).toBeVisible();
    expect(screen.getByLabelText('Period')).toHaveValue('30');
    expect(tile('All users')).toBe('1,240');
    expect(tile('Runova accounts')).toBe('1,230');
    expect(tile('Staff')).toBe('10');
    expect(screen.getByText('2 Admin, 8 Editor')).toBeVisible();
    expect(tile('Joined')).toBe('96');
    expect(screen.getByText('In the last 30 days')).toBeVisible();
    expect(tile('Active')).toBe('620');
    expect(screen.getByText('50% of everyone, last 30 days')).toBeVisible();
    expect(tile('Two-factor on')).toBe('310');
    expect(tile('Email not verified')).toBe('17');
    expect(tile('Disabled')).toBe('3');
    expect(api.calls('GET /api/v1/reports/current?days=30')).toHaveLength(1);
  });

  it('links the tiles that have a list behind them to that list', async () => {
    fakeFetch({ 'GET /api/v1/reports/current?days=30': json(REPORT), [ACTIVITY]: json(page([])) });
    render(<ReportsView />);

    expect(await screen.findByRole('link', { name: 'Runova accounts' })).toHaveAttribute(
      'href',
      '/admin/users?role=Account',
    );
    expect(screen.getByRole('link', { name: 'Disabled' })).toHaveAttribute(
      'href',
      '/admin/users?disabled=true',
    );
    expect(screen.getByRole('link', { name: 'All users' })).toHaveAttribute('href', '/admin/users');
    expect(screen.getByRole('link', { name: 'News' })).toHaveAttribute('href', '/admin/news');
    expect(screen.getByRole('link', { name: 'API clients' })).toHaveAttribute(
      'href',
      '/admin/api-clients',
    );
  });

  it('draws a bar a day for sign-ups, with a table that says the same', async () => {
    fakeFetch({ 'GET /api/v1/reports/current?days=30': json(REPORT), [ACTIVITY]: json(page([])) });
    render(<ReportsView />);

    const chart = (await screen.findByText('Sign-ups per day')).closest('figure') as HTMLElement;
    expect(within(chart).getAllByTestId('sign-up-bar')).toHaveLength(30);
    const total = REPORT.signUps.reduce((sum, day) => sum + day.count, 0);
    expect(within(chart).getByText(`${total} in the last 30 days`)).toBeVisible();
    const table = within(chart).getByRole('table', { name: 'Sign-ups', hidden: true });
    const rows = within(table).getAllByRole('row', { hidden: true }).slice(1);
    expect(rows).toHaveLength(30);
    expect(rows.at(-1)?.textContent).toBe('Nov 69');
  });

  it('reads out the bar under the pointer and goes back to the total after', async () => {
    fakeFetch({ 'GET /api/v1/reports/current?days=30': json(REPORT), [ACTIVITY]: json(page([])) });
    render(<ReportsView />);

    const chart = (await screen.findByText('Sign-ups per day')).closest('figure') as HTMLElement;
    const bars = within(chart).getAllByTestId('sign-up-bar');
    fireEvent.pointerEnter(bars[29]);
    expect(within(chart).getByText('Nov 6: 9')).toBeVisible();
    fireEvent.pointerLeave(bars[29].parentElement as HTMLElement);
    expect(within(chart).queryByText('Nov 6: 9')).toBeNull();
  });

  it('asks again for the period picked, and keeps it in the address', async () => {
    const yearly = { ...REPORT, days: 365, signUps: daysEnding(365, () => 1) };
    const api = fakeFetch({
      'GET /api/v1/reports/current?days=30': json(REPORT),
      'GET /api/v1/reports/current?days=365': json(yearly),
      [ACTIVITY]: json(page([])),
    });
    const user = userEvent.setup();
    render(<ReportsView />);
    await screen.findByText('Sign-ups per day');

    await user.selectOptions(screen.getByLabelText('Period'), '365');

    const chart = (await screen.findByText('Sign-ups per 12 days')).closest(
      'figure',
    ) as HTMLElement;
    expect(within(chart).getAllByTestId('sign-up-bar')).toHaveLength(31);
    expect(within(chart).getByText('365 in the last 12 months')).toBeVisible();
    expect(window.location.search).toBe('?days=365');
    expect(api.calls('GET /api/v1/reports/current?days=365')).toHaveLength(1);
  });

  it('opens with the period the address names, and counts again on Refresh', async () => {
    window.history.replaceState(null, '', '/admin/reports?days=7');
    const week = { ...REPORT, days: 7, signUps: daysEnding(7) };
    const api = fakeFetch({
      'GET /api/v1/reports/current?days=7': json(week),
      [ACTIVITY]: json(page([])),
    });
    const user = userEvent.setup();
    render(<ReportsView />);

    expect(await screen.findByText('0 in the last 7 days')).toBeVisible();
    expect(screen.getByLabelText('Period')).toHaveValue('7');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await screen.findByRole('button', { name: 'Refresh' });
    expect(api.calls('GET /api/v1/reports/current?days=7')).toHaveLength(2);
  });

  it('lists the newest users, each linking to their page', async () => {
    fakeFetch({ 'GET /api/v1/reports/current?days=30': json(REPORT), [ACTIVITY]: json(page([])) });
    render(<ReportsView />);

    const link = await screen.findByRole('link', { name: 'Ada Account' });
    expect(link).toHaveAttribute('href', '/admin/users/1240');
    const items = within(link.closest('ul') as HTMLElement).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(/Runova account, joined/);
    expect(items[1]).toHaveTextContent(/Staff, joined/);
  });

  it('shows sessions by kind, platform and app version', async () => {
    fakeFetch({ 'GET /api/v1/reports/current?days=30': json(REPORT), [ACTIVITY]: json(page([])) });
    render(<ReportsView />);

    await screen.findByRole('heading', { level: 2, name: 'Sessions and computers' });
    expect(tile('Browser sessions')).toBe('410');
    expect(tile('Desktop sessions')).toBe('380');
    const platforms = screen.getByRole('heading', { level: 3, name: 'Desktop platforms' })
      .parentElement as HTMLElement;
    expect(
      within(platforms)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Windows240', 'macOS100', 'Linux40']);
    const versions = screen.getByRole('heading', { level: 3, name: 'Desktop app versions' })
      .parentElement as HTMLElement;
    expect(
      within(versions)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['3.3.0300', 'Unknown version80']);
  });

  it('shows teams, sync and content', async () => {
    fakeFetch({ 'GET /api/v1/reports/current?days=30': json(REPORT), [ACTIVITY]: json(page([])) });
    render(<ReportsView />);

    await screen.findByRole('heading', { level: 2, name: 'Teams and sync' });
    expect(tile('Teams')).toBe('42');
    expect(screen.getByText('150 members')).toBeVisible();
    expect(tile('Pending team invitations')).toBe('6');
    expect(tile('Synced items')).toBe('52,000');
    expect(tile('Synced data')).toBe('3 GB');
    expect(tile('News')).toBe('48');
    expect(screen.getByText('Published; 1 scheduled, 3 drafts')).toBeVisible();
    expect(tile('Blog posts')).toBe('12');
    expect(tile('Media files')).toBe('30');
    expect(tile('API clients')).toBe('2');
    expect(screen.getByText('Active; 1 revoked or expired')).toBeVisible();
    expect(tile('Latest release')).toBe('3.3.0');
  });

  it('says when there are no desktop sessions and no release yet', async () => {
    const quiet = {
      ...REPORT,
      newestUsers: [],
      sessions: { web: 0, desktop: 0, platforms: [], appVersions: [] },
      latestRelease: null,
    };
    fakeFetch({ 'GET /api/v1/reports/current?days=30': json(quiet), [ACTIVITY]: json(page([])) });
    render(<ReportsView />);

    expect(await screen.findAllByText('No desktop sessions in this period.')).toHaveLength(2);
    expect(screen.getByText('No one yet.')).toBeVisible();
    expect(tile('Latest release')).toBe('None');
    expect(screen.getByText('Nothing yet.')).toBeVisible();
  });

  it('lists the recent activity with who did what, linking to both', async () => {
    fakeFetch({
      'GET /api/v1/reports/current?days=30': json(REPORT),
      [ACTIVITY]: json(page(ENTRIES)),
    });
    render(<ReportsView />);

    const table = await screen.findByRole('table', { name: 'Recent activity' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole('cell')
          .slice(1)
          .map((c) => c.textContent),
      ),
    ).toEqual([
      ['User 1', 'Published a news item (48)'],
      ['The site', 'Added a user (2)'],
      ['API client 3', 'Uploaded media (30)'],
    ]);
    expect(within(rows[0]).getByRole('link', { name: 'User 1' })).toHaveAttribute(
      'href',
      '/admin/users/1',
    );
    expect(
      within(rows[0]).getByRole('link', { name: 'Published a news item (48)' }),
    ).toHaveAttribute('href', '/admin/news/48');
    expect(within(rows[2]).queryAllByRole('link')).toHaveLength(0);
  });

  it('still shows the report when the activity can not be read', async () => {
    fakeFetch({
      'GET /api/v1/reports/current?days=30': json(REPORT),
      [ACTIVITY]: problem(500, 'internal'),
    });
    render(<ReportsView />);

    expect(await screen.findByRole('heading', { level: 2, name: 'Users' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Recent activity' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows what went wrong when the report can not be read', async () => {
    fakeFetch({
      'GET /api/v1/reports/current?days=30': problem(403, 'forbidden', {
        detail: 'This needs the Admin role.',
      }),
      [ACTIVITY]: json(page([])),
    });
    render(<ReportsView />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This needs the Admin role.');
    expect(alert).toHaveFocus();
    expect(screen.queryByRole('heading', { level: 2, name: 'Users' })).toBeNull();
  });
});

describe('the report helpers', () => {
  it('read the period from the address, and only one the page offers', () => {
    expect(readPeriod('')).toBe(30);
    expect(readPeriod('?days=7')).toBe(7);
    expect(readPeriod('?days=90')).toBe(90);
    expect(readPeriod('?days=365')).toBe(365);
    expect(readPeriod('?days=12')).toBe(30);
    expect(readPeriod('?days=abc')).toBe(30);
  });

  it('give a share as a whole percent, and 0% of nothing', () => {
    expect(percentOf(1, 3)).toBe('33%');
    expect(percentOf(620, 1240)).toBe('50%');
    expect(percentOf(0, 0)).toBe('0%');
  });

  it('write bytes in 1024 steps', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(1023)).toBe('1023 bytes');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(2 * 1024 ** 5)).toBe('2048 TB');
  });

  it('name a UTC day without moving it to the reader’s zone', () => {
    expect(formatDay('2026-11-06')).toBe('Nov 6');
    expect(formatDay('2026-01-01')).toBe('Jan 1');
  });

  it('keep a bar a day up to 31 days', () => {
    const month = daysEnding(31, (index) => index);
    const bars = bucketDays(month);
    expect(bars).toHaveLength(31);
    expect(bars[30]).toEqual({ label: 'Nov 6', count: 30 });
  });

  it('sum runs of days past 31, keeping the newest days whole and every sign-up counted', () => {
    const quarter = daysEnding(90, () => 1);
    const bars = bucketDays(quarter);
    expect(bars).toHaveLength(30);
    expect(bars.at(-1)).toEqual({ label: 'Nov 4 to Nov 6', count: 3 });
    expect(bars.reduce((sum, bar) => sum + bar.count, 0)).toBe(90);

    const year = bucketDays(daysEnding(365, () => 2));
    expect(year).toHaveLength(31);
    expect(year[0].count).toBe(2 * (365 - 30 * 12));
    expect(year.reduce((sum, bar) => sum + bar.count, 0)).toBe(730);
  });

  it('name platforms and app versions, even when the computer sent none', () => {
    expect(platformName('windows')).toBe('Windows');
    expect(platformName('MacOS')).toBe('macOS');
    expect(platformName('freebsd')).toBe('freebsd');
    expect(platformName('')).toBe('Unknown');
    expect(versionName('3.3.0')).toBe('3.3.0');
    expect(versionName('')).toBe('Unknown version');
  });

  it('name each audit action and who did it', () => {
    expect(actionLabel('user.password-reset')).toBe('Reset a password');
    expect(actionLabel('something.new')).toBe('something.new');
    expect(actorLabel({ actorKind: 'system', actorId: null })).toBe('The site');
    expect(actorLabel({ actorKind: 'user', actorId: 4 })).toBe('User 4');
    expect(actorLabel({ actorKind: 'user', actorId: null })).toBe('User');
    expect(actorLabel({ actorKind: 'api-client', actorId: 3 })).toBe('API client 3');
  });
});
