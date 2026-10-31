// @vitest-environment jsdom
import './setup/dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import NewsEditor from '../src/components/admin/NewsEditor';
import { NEWS_ITEM, TECHNOLOGIES } from './fixtures/admin/items';
import { enter } from './helpers/enter';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';

const techRoute = { 'GET /api/v1/technologies': json(TECHNOLOGIES) };

beforeEach(() => {
  document.cookie = 'XSRF-TOKEN=xsrf; path=/';
  window.history.replaceState(null, '', '/admin/news/new');
});

async function fillNewItem(user: ReturnType<typeof userEvent.setup>) {
  await enter(user, screen.getByLabelText('Title'), 'Git 2.47.1 fixes a clone bug');
  await enter(
    user,
    screen.getByLabelText('Summary'),
    'Cloning a crafted repository could write outside the target folder.',
  );
  await user.selectOptions(screen.getByLabelText('Category'), 'security');
  await user.selectOptions(screen.getByLabelText('Severity'), 'high');
  await user.selectOptions(await screen.findByLabelText('Technology to add'), 'git');
  await user.click(screen.getByRole('button', { name: 'Add technology' }));
  const range = screen.getByLabelText('Affected versions of Git');
  await user.clear(range);
  await enter(user, range, '<2.47.1');
  await enter(user, screen.getByLabelText('Fixed in for Git'), '2.47.1');
  await enter(user, screen.getByLabelText('CVE ids'), 'cve-2026-50001');
  await enter(user, screen.getByLabelText('Body (Markdown)'), 'Update Git.');
}

describe('NewsEditor, a new item', () => {
  it('sends the write DTO, then moves to the saved item', async () => {
    const api = fakeFetch({
      ...techRoute,
      'POST /api/v1/news': json(
        { ...NEWS_ITEM, id: 101, title: 'Git 2.47.1 fixes a clone bug', version: '1' },
        { status: 201, headers: { etag: '"1"' } },
      ),
    });
    const user = userEvent.setup();
    render(<NewsEditor />);

    await fillNewItem(user);
    expect(screen.getByLabelText('Slug')).toHaveValue('git-2-47-1-fixes-a-clone-bug');
    await user.click(screen.getByRole('radio', { name: 'Publish now' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    const [post] = api.calls('POST /api/v1/news');
    expect(post.headers.get('x-xsrf-token')).toBe('xsrf');
    expect(post.json()).toEqual({
      slug: 'git-2-47-1-fixes-a-clone-bug',
      title: 'Git 2.47.1 fixes a clone bug',
      summary: 'Cloning a crafted repository could write outside the target folder.',
      bodyMarkdown: 'Update Git.',
      category: 'security',
      severity: 'high',
      technologies: [{ technology: 'git', versionRange: '<2.47.1', fixedIn: '2.47.1' }],
      cveIds: ['CVE-2026-50001'],
      cvssScore: null,
      sourceLinks: [],
      tags: [],
      status: 'published',
      publishedAt: null,
    });
    expect(window.location.pathname).toBe('/admin/news/101');
  });

  it('shows each field error from the problem next to its field', async () => {
    fakeFetch({
      ...techRoute,
      'POST /api/v1/news': problem(400, 'validation-failed', {
        errors: {
          title: ['A title is 5 to 160 characters.'],
          'technologies[0].versionRange': ['A version range is like >=9.8.0 <10.3.0.'],
          'cveIds[0]': ['A CVE id looks like CVE-2026-41234.'],
          publishedAt: ['A scheduled item needs a publishedAt in the future.'],
          antiforgery: ['Send the X-XSRF-TOKEN header.'],
        },
      }),
    });
    const user = userEvent.setup();
    render(<NewsEditor />);
    await fillNewItem(user);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    const title = screen.getByLabelText('Title');
    await waitFor(() => expect(title).toHaveAttribute('aria-invalid', 'true'));
    expect(title).toHaveAccessibleDescription('A title is 5 to 160 characters.');
    expect(screen.getByLabelText('Affected versions of Git')).toHaveAccessibleDescription(
      'A version range is like >=9.8.0 <10.3.0.',
    );
    expect(screen.getByLabelText('CVE ids')).toHaveAccessibleDescription(
      expect.stringContaining('Entry 1: A CVE id looks like CVE-2026-41234.'),
    );
    expect(screen.getByLabelText('Summary')).not.toHaveAttribute('aria-invalid');

    const summary = screen.getByRole('alert');
    expect(summary).toHaveTextContent('One or more fields are not valid.');
    expect(summary).toHaveTextContent('Send the X-XSRF-TOKEN header.');
    expect(summary).toHaveTextContent('A scheduled item needs a publishedAt in the future.');
    expect(summary).toHaveFocus();
  });

  it('limits the severity to what the category allows and suggests one from the CVSS score', async () => {
    fakeFetch(techRoute);
    const user = userEvent.setup();
    render(<NewsEditor />);
    const severity = screen.getByLabelText('Severity');

    await user.selectOptions(screen.getByLabelText('Category'), 'release');
    expect(
      within(severity)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Info']);

    await user.selectOptions(screen.getByLabelText('Category'), 'security');
    expect(
      within(severity)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Low', 'Medium', 'High', 'Critical']);
    await user.type(screen.getByLabelText('CVSS score'), '9.1');
    await user.click(screen.getByRole('button', { name: 'Use Critical' }));
    expect(severity).toHaveValue('critical');
  });

  it('schedules an item for the time picked in local time', async () => {
    const api = fakeFetch({
      ...techRoute,
      'POST /api/v1/news': json(
        { ...NEWS_ITEM, id: 102, status: 'scheduled' },
        { status: 201, headers: { etag: '"1"' } },
      ),
    });
    const user = userEvent.setup();
    render(<NewsEditor />);
    await fillNewItem(user);

    await user.click(screen.getByRole('radio', { name: 'Schedule' }));
    fireEvent.change(screen.getByLabelText('Publish at'), {
      target: { value: '2030-01-15T09:30' },
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('status');
    expect(api.calls('POST /api/v1/news')[0].json()).toMatchObject({
      status: 'scheduled',
      publishedAt: new Date(2030, 0, 15, 9, 30).toISOString(),
    });
  });
});

describe('NewsEditor, the Markdown preview', () => {
  it('renders the body as you type and drops anything unsafe', async () => {
    fakeFetch(techRoute);
    const user = userEvent.setup();
    render(<NewsEditor />);
    const body = screen.getByLabelText('Body (Markdown)');

    await user.type(body, '## Affected{enter}{enter}Run **git** <img src=x onerror=alert(1)>');
    fireEvent.change(body, {
      target: { value: `${(body as HTMLTextAreaElement).value}\n\n<script>alert(2)</script>` },
    });

    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(within(preview).getByRole('heading', { level: 2, name: 'Affected' })).toBeVisible();
    expect(preview.querySelector('strong')).toHaveTextContent('git');
    expect(preview.innerHTML).not.toContain('onerror');
    expect(preview.querySelector('script')).toBeNull();
  });
});

describe('NewsEditor, an existing item', () => {
  const itemRoute = (version: string, title = NEWS_ITEM.title) =>
    json({ ...NEWS_ITEM, title, version }, { headers: { etag: `"${version}"` } });

  it('loads the item and saves it with If-Match', async () => {
    const api = fakeFetch({
      ...techRoute,
      'GET /api/v1/news/42': itemRoute('12'),
      'PUT /api/v1/news/42': itemRoute('13'),
    });
    const user = userEvent.setup();
    render(<NewsEditor id={42} />);

    const title = await screen.findByDisplayValue(NEWS_ITEM.title);
    expect(screen.getByLabelText('Affected versions of OpenSSH')).toHaveValue('>=9.8.0 <10.3.0');
    expect(screen.getByLabelText('CVE ids')).toHaveValue('CVE-2026-41234');
    expect(screen.getByRole('radio', { name: 'Publish now' })).toBeChecked();
    await user.type(title, ' today');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('status');
    const [put] = api.calls('PUT /api/v1/news/42');
    expect(put.headers.get('if-match')).toBe('"12"');
    expect(put.json()).toMatchObject({
      title: `${NEWS_ITEM.title} today`,
      slug: NEWS_ITEM.slug,
      technologies: [{ technology: 'openssh', versionRange: '>=9.8.0 <10.3.0', fixedIn: '10.3.0' }],
      sourceLinks: NEWS_ITEM.sourceLinks,
      tags: ['ssh', 'servers'],
      cvssScore: 7.5,
      status: 'published',
      publishedAt: NEWS_ITEM.publishedAt,
    });

    // The next save goes against the version this one made.
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls('PUT /api/v1/news/42')).toHaveLength(2));
    expect(api.calls('PUT /api/v1/news/42')[1].headers.get('if-match')).toBe('"13"');
  });

  it('shows the conflict dialog on 412 instead of overwriting, and loads the newer version', async () => {
    const api = fakeFetch({
      ...techRoute,
      'GET /api/v1/news/42': [itemRoute('12'), itemRoute('14', 'Their newer title')],
      'PUT /api/v1/news/42': problem(412, 'precondition-failed', { currentVersion: '14' }),
    });
    const user = userEvent.setup();
    render(<NewsEditor id={42} />);
    await user.type(await screen.findByDisplayValue(NEWS_ITEM.title), ' mine');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Someone else saved this item',
    });
    expect(api.calls('PUT /api/v1/news/42')).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Load their version' }));

    expect(await screen.findByDisplayValue('Their newer title')).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.calls('PUT /api/v1/news/42')).toHaveLength(1);
  });

  it('saves over the newer version only when asked to', async () => {
    const api = fakeFetch({
      ...techRoute,
      'GET /api/v1/news/42': itemRoute('12'),
      'PUT /api/v1/news/42': [
        problem(412, 'precondition-failed', { currentVersion: '14' }),
        itemRoute('15'),
      ],
    });
    const user = userEvent.setup();
    render(<NewsEditor id={42} />);
    await screen.findByDisplayValue(NEWS_ITEM.title);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save mine over theirs' }));

    await screen.findByRole('status');
    const puts = api.calls('PUT /api/v1/news/42');
    expect(puts.map((each) => each.headers.get('if-match'))).toEqual(['"12"', '"14"']);
  });

  it('keeps the dialog keyboard-only: it takes focus and Escape closes it', async () => {
    fakeFetch({
      ...techRoute,
      'GET /api/v1/news/42': itemRoute('12'),
      'PUT /api/v1/news/42': problem(412, 'precondition-failed', { currentVersion: '14' }),
    });
    const user = userEvent.setup();
    render(<NewsEditor id={42} />);
    await screen.findByDisplayValue(NEWS_ITEM.title);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
  });
});
