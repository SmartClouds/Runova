// @vitest-environment jsdom
import './setup/dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import Notifications from '../src/components/account/Notifications';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';

const SETTINGS = {
  enabled: true,
  securityMinSeverity: 'high',
  deprecated: true,
  major: true,
  minor: false,
  patch: false,
  inApp: true,
  telegram: true,
};

const NOT_LINKED = {
  available: true,
  linked: false,
  botUsername: 'RunovaHQBot',
  chatName: null,
  linkedAt: null,
};

const NOTIFICATION = {
  id: 11,
  kind: 'dependency-updates',
  title: '2 package updates for Shop',
  body: 'lodash 4.17.20 to 4.17.21: high security issue, Command injection (GHSA-1)\nexpress 4.18.0 to 5.0.0: major update',
  severity: 'high',
  scopeId: 1,
  itemId: 'p-shop',
  inventoryId: 7,
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  readAt: null,
};

const page = (items: unknown[], unread = items.length) =>
  json({ items, page: 1, pageSize: 20, totalItems: items.length, totalPages: 1, unread });

function routes(overrides: Parameters<typeof fakeFetch>[0] = {}) {
  return fakeFetch({
    'GET /api/v1/accounts/me/dependency-alert-settings': json(SETTINGS, {
      headers: { etag: '"41"' },
    }),
    'GET /api/v1/accounts/me/telegram-links/current': json(NOT_LINKED),
    'GET /api/v1/notifications?pageSize=20': page([NOTIFICATION]),
    ...overrides,
  });
}

beforeEach(() => {
  document.cookie = 'XSRF-TOKEN=xsrf; path=/';
});

describe('Notifications', () => {
  it('shows the alert settings of the account', async () => {
    routes();
    render(<Notifications />);

    expect(await screen.findByRole('checkbox', { name: 'Package update alerts' })).toBeChecked();
    expect(screen.getByLabelText('Security issues at')).toHaveValue('high');
    expect(screen.getByRole('checkbox', { name: 'Major updates' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Minor updates' })).not.toBeChecked();
  });

  it('saves a change with the version it read', async () => {
    const api = routes({
      'PATCH /api/v1/accounts/me/dependency-alert-settings': json(
        { ...SETTINGS, minor: true },
        { headers: { etag: '"42"' } },
      ),
    });
    const user = userEvent.setup();
    render(<Notifications />);

    await user.click(await screen.findByRole('checkbox', { name: 'Minor updates' }));

    await waitFor(() =>
      expect(api.calls('PATCH /api/v1/accounts/me/dependency-alert-settings')).toHaveLength(1),
    );
    const patch = api.calls('PATCH /api/v1/accounts/me/dependency-alert-settings')[0];
    expect(patch?.json()).toEqual({ minor: true });
    expect(patch?.headers.get('if-match')).toBe('"41"');
    expect(screen.getByRole('checkbox', { name: 'Minor updates' })).toBeChecked();
  });

  it('saves two quick changes one after the other, each with the newest version', async () => {
    // The first answer is held back until the second change has been made.
    let answerFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      answerFirst = resolve;
    });
    const api = routes({
      'PATCH /api/v1/accounts/me/dependency-alert-settings': [
        async () => {
          await firstHeld;
          return json({ ...SETTINGS, minor: true }, { headers: { etag: '"42"' } });
        },
        json({ ...SETTINGS, minor: true, patch: true }, { headers: { etag: '"43"' } }),
      ],
    });
    const user = userEvent.setup();
    render(<Notifications />);

    await user.click(await screen.findByRole('checkbox', { name: 'Minor updates' }));
    await user.click(screen.getByRole('checkbox', { name: 'Patch updates' }));
    answerFirst();

    await waitFor(() =>
      expect(api.calls('PATCH /api/v1/accounts/me/dependency-alert-settings')).toHaveLength(2),
    );
    const [first, second] = api.calls('PATCH /api/v1/accounts/me/dependency-alert-settings');
    expect(first?.headers.get('if-match')).toBe('"41"');
    expect(second?.headers.get('if-match')).toBe('"42"');
    expect(screen.getByRole('checkbox', { name: 'Minor updates' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Patch updates' })).toBeChecked();
  });

  it('turning it off greys out the kinds', async () => {
    routes({
      'PATCH /api/v1/accounts/me/dependency-alert-settings': json(
        { ...SETTINGS, enabled: false },
        { headers: { etag: '"42"' } },
      ),
    });
    const user = userEvent.setup();
    render(<Notifications />);

    await user.click(await screen.findByRole('checkbox', { name: 'Package update alerts' }));

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Major updates' })).toBeDisabled(),
    );
  });

  it('makes a one-time Telegram link, and unlinks a linked chat', async () => {
    const api = routes({
      'POST /api/v1/accounts/me/telegram-link-codes': json(
        {
          url: 'https://t.me/RunovaHQBot?start=abc',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
        { status: 201 },
      ),
    });
    const user = userEvent.setup();
    render(<Notifications />);

    await user.click(await screen.findByRole('button', { name: 'Link Telegram' }));

    const open = await screen.findByRole('link', { name: /Open Telegram/ });
    expect(open).toHaveAttribute('href', 'https://t.me/RunovaHQBot?start=abc');
    expect(
      api.calls('POST /api/v1/accounts/me/telegram-link-codes')[0]?.headers.get('x-xsrf-token'),
    ).toBe('xsrf');
  });

  it('shows a linked chat and unlinks it', async () => {
    const api = routes({
      'GET /api/v1/accounts/me/telegram-links/current': [
        json({
          ...NOT_LINKED,
          linked: true,
          chatName: '@sam_dev',
          linkedAt: NOTIFICATION.createdAt,
        }),
        json(NOT_LINKED),
      ],
      'DELETE /api/v1/accounts/me/telegram-links/current': new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    render(<Notifications />);

    expect(await screen.findByText(/@sam_dev/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unlink' }));

    await waitFor(() =>
      expect(api.calls('DELETE /api/v1/accounts/me/telegram-links/current')).toHaveLength(1),
    );
    expect(await screen.findByRole('button', { name: 'Link Telegram' })).toBeInTheDocument();
  });

  it('says so when the site has no Telegram bot', async () => {
    routes({
      'GET /api/v1/accounts/me/telegram-links/current': json({
        ...NOT_LINKED,
        available: false,
        botUsername: null,
      }),
    });
    render(<Notifications />);

    expect(await screen.findByText(/Telegram is not available/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link Telegram' })).not.toBeInTheDocument();
  });

  it('lists the messages with one line per package and marks them read', async () => {
    const api = routes({
      'POST /api/v1/notification-read-markers': json({ marked: 1 }, { status: 201 }),
      'GET /api/v1/notifications?pageSize=20': [
        page([NOTIFICATION]),
        page([{ ...NOTIFICATION, readAt: new Date().toISOString() }], 0),
      ],
    });
    const user = userEvent.setup();
    render(<Notifications />);

    expect(await screen.findByText('2 package updates for Shop')).toBeInTheDocument();
    expect(screen.getByText(/express 4.18.0 to 5.0.0: major update/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));

    await waitFor(() =>
      expect(api.calls('POST /api/v1/notification-read-markers')).toHaveLength(1),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Mark all as read' })).not.toBeInTheDocument(),
    );
  });

  it('has an empty state before the first check', async () => {
    routes({ 'GET /api/v1/notifications?pageSize=20': page([]) });
    render(<Notifications />);

    expect(await screen.findByText('No messages yet')).toBeInTheDocument();
  });

  it('shows a failed save as a message', async () => {
    routes({
      'PATCH /api/v1/accounts/me/dependency-alert-settings': problem(412, 'precondition-failed', {
        detail: 'This was changed since you read it.',
      }),
    });
    const user = userEvent.setup();
    render(<Notifications />);

    await user.click(await screen.findByRole('checkbox', { name: 'Patch updates' }));

    expect(await screen.findByText(/changed since you read it/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Patch updates' })).not.toBeChecked();
  });
});
