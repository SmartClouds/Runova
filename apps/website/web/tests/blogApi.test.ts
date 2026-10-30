import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlogApi, parsePost, parsePostPage } from '../src/lib/blog/api';
import { FIXTURE_POSTS } from './fixtures/blog/posts';
import { type FakeBlogApi, startFakeBlogApi } from './helpers/fakeBlogApi';
import { deadApiUrl } from './helpers/fakeReleaseApi';

let api: FakeBlogApi;
let unavailable: FakeBlogApi;

beforeAll(async () => {
  api = await startFakeBlogApi();
  unavailable = await startFakeBlogApi({ status: 503 });
});

afterAll(async () => {
  await api?.close();
  await unavailable?.close();
});

describe('parsePostPage', () => {
  it('reads a page of list items', () => {
    const { bodyHtml: _, ...item } = FIXTURE_POSTS[0];
    const page = parsePostPage({
      items: [item],
      page: 1,
      pageSize: 10,
      totalItems: 1,
      totalPages: 1,
    });
    expect(page?.items[0]).toEqual(item);
    expect(page?.totalPages).toBe(1);
  });

  it('refuses a page without its paging numbers', () => {
    expect(parsePostPage({ items: [] })).toBeNull();
    expect(parsePostPage(null)).toBeNull();
  });

  it('drops an item it cannot show and keeps the rest', () => {
    const { bodyHtml: _, ...item } = FIXTURE_POSTS[1];
    const page = parsePostPage({
      items: [{ ...item, slug: '' }, item],
      page: 1,
      pageSize: 10,
      totalItems: 2,
      totalPages: 1,
    });
    expect(page?.items.map((post) => post.slug)).toEqual([item.slug]);
  });
});

describe('parsePost', () => {
  it('reads a post with its body', () => {
    expect(parsePost(FIXTURE_POSTS[0])).toEqual(FIXTURE_POSTS[0]);
  });

  it('refuses a post without a body or a published time', () => {
    const { bodyHtml: _, ...noBody } = FIXTURE_POSTS[0];
    expect(parsePost(noBody)).toBeNull();
    expect(parsePost({ ...FIXTURE_POSTS[0], publishedAt: null })).toBeNull();
  });

  it('refuses a cover image without its size', () => {
    const post = FIXTURE_POSTS[0];
    const cover = { url: post.coverImage?.url, alt: 'x' };
    expect(parsePost({ ...post, coverImage: cover })).toBeNull();
  });
});

describe('createBlogApi', () => {
  it('asks for a page of posts with the size and tag', async () => {
    const blog = createBlogApi(api.url);
    const result = await blog.listPosts({ page: 2, pageSize: 10 });
    expect(result.ok && result.value.items.map((post) => post.id)).toEqual(
      FIXTURE_POSTS.slice(10, 20).map((post) => post.id),
    );
    const tagged = await blog.listPosts({ tags: ['relay'], pageSize: 10 });
    expect(tagged.ok && tagged.value.totalItems).toBe(2);
    const either = await blog.listPosts({ tags: ['agents', 'git'], pageSize: 10 });
    expect(either.ok && either.value.totalItems).toBe(2);
    expect(api.requests).toContain('/api/v1/posts?page=2&pageSize=10');
    expect(api.requests).toContain('/api/v1/posts?tag=relay&page=1&pageSize=10');
    expect(api.requests).toContain('/api/v1/posts?tag=agents&tag=git&page=1&pageSize=10');
  });

  it('reads one post by slug', async () => {
    const result = await createBlogApi(api.url).getPost(FIXTURE_POSTS[0].slug);
    expect(result).toEqual({ ok: true, value: FIXTURE_POSTS[0] });
  });

  it('tells a missing post from an API that is down', async () => {
    expect(await createBlogApi(api.url).getPost('no-such-post')).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await createBlogApi(unavailable.url).getPost(FIXTURE_POSTS[0].slug)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(await createBlogApi(await deadApiUrl()).listPosts({})).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('is unavailable without an API URL', async () => {
    expect(await createBlogApi(undefined).listPosts({})).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('gives up on a slow API', async () => {
    // Answers only when the request is aborted.
    const blog = createBlogApi('http://api.test', {
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    expect(await blog.listPosts({})).toEqual({ ok: false, reason: 'unavailable' });
  });
});
