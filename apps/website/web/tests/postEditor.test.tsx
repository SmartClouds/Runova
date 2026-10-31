// @vitest-environment jsdom
import './setup/dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import PostEditor from '../src/components/admin/PostEditor';
import { POST } from './fixtures/admin/items';
import { enter } from './helpers/enter';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';

const MEDIA = {
  id: 31,
  url: '/media/2026/10/cover.webp',
  contentType: 'image/webp',
  width: 1200,
  height: 630,
  size: 48000,
  alt: 'Two handoff notes on a desk',
  createdAt: '2026-10-31T08:00:00.000Z',
};

const coverFile = () => new File(['png'], 'cover.png', { type: 'image/png' });

beforeEach(() => {
  document.cookie = 'XSRF-TOKEN=xsrf; path=/';
  window.history.replaceState(null, '', '/admin/blog/new');
});

async function uploadCover(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText('Cover image file'), coverFile());
  await enter(user, screen.getByLabelText('Alt text'), MEDIA.alt);
  await user.click(screen.getByRole('button', { name: 'Upload cover' }));
}

describe('PostEditor, a new post', () => {
  it('uploads the cover, then sends the write DTO with its media id', async () => {
    const api = fakeFetch({
      'POST /api/v1/media': json(MEDIA, { status: 201 }),
      'POST /api/v1/posts': json(
        { ...POST, id: 77, title: 'Handoffs that survive a reset' },
        { status: 201, headers: { etag: '"1"' } },
      ),
    });
    const user = userEvent.setup();
    render(<PostEditor />);

    await enter(user, screen.getByLabelText('Title'), 'Handoffs that survive a reset');
    await enter(
      user,
      screen.getByLabelText('Excerpt'),
      'What a session writes down so the next one can start cold.',
    );
    await enter(user, screen.getByLabelText('Tags'), 'Relay, AI agents');
    await enter(user, screen.getByLabelText('Body (Markdown)'), 'Write it **down**.');
    await uploadCover(user);

    expect(await screen.findByRole('img', { name: MEDIA.alt })).toHaveAttribute('src', MEDIA.url);
    const [upload] = api.calls('POST /api/v1/media');
    expect(upload.headers.get('x-xsrf-token')).toBe('xsrf');
    const parts = upload.body as FormData;
    expect((parts.get('file') as File).name).toBe('cover.png');
    expect(parts.get('alt')).toBe(MEDIA.alt);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(api.calls('POST /api/v1/posts')[0].json()).toEqual({
      slug: 'handoffs-that-survive-a-reset',
      title: 'Handoffs that survive a reset',
      excerpt: 'What a session writes down so the next one can start cold.',
      bodyMarkdown: 'Write it **down**.',
      coverMediaId: 31,
      tags: ['Relay', 'AI agents'],
      status: 'draft',
      publishedAt: null,
    });
    expect(window.location.pathname).toBe('/admin/blog/77');
  });

  it('shows the upload errors next to the file and alt fields', async () => {
    fakeFetch({
      'POST /api/v1/media': problem(400, 'validation-failed', {
        errors: {
          file: ['Only PNG, JPEG, WebP and AVIF images can be uploaded.'],
          alt: ['Describe the image in 1 to 200 characters.'],
        },
      }),
    });
    const user = userEvent.setup();
    render(<PostEditor />);

    await uploadCover(user);

    const file = screen.getByLabelText('Cover image file');
    await waitFor(() => expect(file).toHaveAttribute('aria-invalid', 'true'));
    expect(file).toHaveAccessibleDescription(
      expect.stringContaining('Only PNG, JPEG, WebP and AVIF images can be uploaded.'),
    );
    expect(screen.getByLabelText('Alt text')).toHaveAccessibleDescription(
      expect.stringContaining('Describe the image in 1 to 200 characters.'),
    );
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('says a file over 5 MB is too large, on the file field', async () => {
    fakeFetch({
      'POST /api/v1/media': problem(413, 'payload-too-large', {
        detail: 'An upload is at most 5 MB.',
      }),
    });
    const user = userEvent.setup();
    render(<PostEditor />);

    await uploadCover(user);

    await waitFor(() =>
      expect(screen.getByLabelText('Cover image file')).toHaveAccessibleDescription(
        expect.stringContaining('An upload is at most 5 MB.'),
      ),
    );
  });
});

describe('PostEditor, an existing post', () => {
  const postRoute = (version: string, extra: Record<string, unknown> = {}) =>
    json({ ...POST, ...extra, version }, { headers: { etag: `"${version}"` } });

  it('loads the post and saves a merge patch with If-Match, leaving the cover alone', async () => {
    const api = fakeFetch({
      'GET /api/v1/posts/9': postRoute('5'),
      'PATCH /api/v1/posts/9': postRoute('6'),
    });
    const user = userEvent.setup();
    render(<PostEditor id={9} />);

    const title = await screen.findByDisplayValue(POST.title);
    expect(screen.getByLabelText('Tags')).toHaveValue('relay, agents');
    expect(screen.getByRole('img', { name: 'The Relay board' })).toBeVisible();
    expect(screen.getByRole('radio', { name: 'Draft' })).toBeChecked();
    await user.type(title, ' now');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('status');
    const [patch] = api.calls('PATCH /api/v1/posts/9');
    expect(patch.headers.get('if-match')).toBe('"5"');
    expect(patch.headers.get('content-type')).toBe('application/merge-patch+json');
    const body = patch.json() as Record<string, unknown>;
    expect(body).toMatchObject({ title: `${POST.title} now`, tags: ['relay', 'agents'] });
    expect(body).not.toHaveProperty('coverMediaId');
  });

  it('removes the cover by sending a null media id', async () => {
    const api = fakeFetch({
      'GET /api/v1/posts/9': postRoute('5'),
      'PATCH /api/v1/posts/9': postRoute('6', { coverImage: null }),
    });
    const user = userEvent.setup();
    render(<PostEditor id={9} />);
    await screen.findByDisplayValue(POST.title);

    await user.click(screen.getByRole('button', { name: 'Remove cover' }));
    expect(screen.queryByRole('img')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByRole('status');
    expect(api.calls('PATCH /api/v1/posts/9')[0].json()).toMatchObject({ coverMediaId: null });
  });

  it('shows the conflict dialog on 412 and loads the newer version', async () => {
    const api = fakeFetch({
      'GET /api/v1/posts/9': [postRoute('5'), postRoute('7', { title: 'Their post title' })],
      'PATCH /api/v1/posts/9': problem(412, 'precondition-failed', { currentVersion: '7' }),
    });
    const user = userEvent.setup();
    render(<PostEditor id={9} />);
    await screen.findByDisplayValue(POST.title);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Someone else saved this item',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Load their version' }));

    expect(await screen.findByDisplayValue('Their post title')).toBeVisible();
    expect(api.calls('PATCH /api/v1/posts/9')).toHaveLength(1);
  });
});
