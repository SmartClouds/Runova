// @vitest-environment jsdom
import './setup/dom';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import ItemList from '../src/components/admin/ItemList';
import { NEWS_ITEM, POST } from './fixtures/admin/items';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';

const LIVE = 'status=draft&status=scheduled&status=published';
const page = (items: unknown[], at = 1, totalPages = 1) =>
  json({ items, page: at, pageSize: 20, totalItems: items.length, totalPages });

const draft = { ...NEWS_ITEM, id: 43, title: 'A draft about Node.js', publishedAt: null };
const scheduled = {
  ...NEWS_ITEM,
  id: 44,
  title: 'Node.js 26 goes LTS next week',
  publishedAt: '2099-01-01T08:00:00.000Z',
};

beforeEach(() => {
  window.history.replaceState(null, '', '/admin/news');
});

describe('ItemList for news', () => {
  it('lists drafts, scheduled and published items, each linking to its editor', async () => {
    fakeFetch({
      [`GET /api/v1/news?${LIVE}&page=1&pageSize=20`]: page([draft, scheduled, NEWS_ITEM]),
    });
    render(<ItemList kind="news" />);

    const link = await screen.findByRole('link', { name: NEWS_ITEM.title });
    expect(link).toHaveAttribute('href', '/admin/news/42');
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual([
      'Draft',
      'Scheduled',
      'Published',
    ]);
    expect(within(rows[2]).getByText('Security, High')).toBeVisible();
    expect(screen.getByRole('link', { name: 'New news item' })).toHaveAttribute(
      'href',
      '/admin/news/new',
    );
  });

  it('filters by status and keeps the filter in the address', async () => {
    const archived = { ...NEWS_ITEM, id: 40, title: 'An old advisory' };
    const api = fakeFetch({
      [`GET /api/v1/news?${LIVE}&page=1&pageSize=20`]: page([NEWS_ITEM]),
      'GET /api/v1/news?status=archived&page=1&pageSize=20': page([archived]),
    });
    const user = userEvent.setup();
    render(<ItemList kind="news" />);
    await screen.findByRole('link', { name: NEWS_ITEM.title });

    await user.selectOptions(screen.getByLabelText('Status'), 'archived');

    expect(await screen.findByRole('link', { name: 'An old advisory' })).toBeVisible();
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Archived');
    expect(window.location.search).toBe('?status=archived');
    expect(api.calls('GET /api/v1/news?status=archived&page=1&pageSize=20')).toHaveLength(1);
  });

  it('pages through the list', async () => {
    window.history.replaceState(null, '', '/admin/news?page=2');
    fakeFetch({
      [`GET /api/v1/news?${LIVE}&page=2&pageSize=20`]: page([NEWS_ITEM], 2, 3),
      [`GET /api/v1/news?${LIVE}&page=3&pageSize=20`]: page([draft], 3, 3),
    });
    const user = userEvent.setup();
    render(<ItemList kind="news" />);

    expect(await screen.findByText('Page 2 of 3')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next page' }));

    expect(await screen.findByRole('link', { name: draft.title })).toBeVisible();
    expect(screen.getByText('Page 3 of 3')).toBeVisible();
    const next = screen.getByRole('button', { name: 'Next page' });
    expect(next).toHaveAttribute('aria-disabled', 'true');
    expect(next).toHaveFocus();
    expect(window.location.search).toBe('?page=3');
  });

  it('says when the list could not be loaded', async () => {
    fakeFetch({
      [`GET /api/v1/news?${LIVE}&page=1&pageSize=20`]: problem(503, 'unavailable', {
        detail: 'The database is not answering.',
      }),
    });
    render(<ItemList kind="news" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The database is not answering.');
  });
});

describe('ItemList for posts', () => {
  it('lists posts with their tags, linking to the blog editor', async () => {
    window.history.replaceState(null, '', '/admin/blog');
    fakeFetch({ [`GET /api/v1/posts?${LIVE}&page=1&pageSize=20`]: page([POST]) });
    render(<ItemList kind="posts" />);

    const link = await screen.findByRole('link', { name: POST.title });
    expect(link).toHaveAttribute('href', '/admin/blog/9');
    expect(screen.getByText('relay, agents')).toBeVisible();
    expect(screen.getByRole('link', { name: 'New post' })).toHaveAttribute(
      'href',
      '/admin/blog/new',
    );
  });
});
