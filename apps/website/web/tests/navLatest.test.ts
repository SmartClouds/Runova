import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { APIContext } from 'astro';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlogApi } from '../src/lib/blog/api';
import { LATEST_COUNT, loadLatest, postTone } from '../src/lib/latest';
import { createNewsApi } from '../src/lib/news/api';
import { CACHE } from '../src/lib/news/page';
import { GET } from '../src/pages/nav/latest.json';
import { FIXTURE_POSTS } from './fixtures/blog/posts';
import { FIXTURE_NEWS } from './fixtures/news/items';
import { type FakeBlogApi, handleBlogRequest, startFakeBlogApi } from './helpers/fakeBlogApi';
import { type FakeNewsApi, handleNewsRequest, startFakeNewsApi } from './helpers/fakeNewsApi';

let news: FakeNewsApi;
let blog: FakeBlogApi;

beforeAll(async () => {
  [news, blog] = await Promise.all([startFakeNewsApi(), startFakeBlogApi()]);
});

afterAll(async () => {
  await Promise.all([news.close(), blog.close()]);
});

const DEAD = 'http://127.0.0.1:9';

describe('loadLatest', () => {
  it('asks for the first page of three of each', async () => {
    news.requests.length = 0;
    blog.requests.length = 0;
    await loadLatest(createNewsApi(news.url), createBlogApi(blog.url));
    expect(news.requests).toEqual([`/api/v1/news?page=1&pageSize=${LATEST_COUNT}`]);
    expect(blog.requests).toEqual([`/api/v1/posts?page=1&pageSize=${LATEST_COUNT}`]);
  });

  it('words the three newest news items for the menu, newest first', async () => {
    const latest = await loadLatest(createNewsApi(news.url), createBlogApi(blog.url));
    const newest = [...FIXTURE_NEWS]
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, LATEST_COUNT);
    expect(latest.news?.map((entry) => entry.href)).toEqual(
      newest.map((item) => `/news/${item.slug}`),
    );
    const [first] = latest.news ?? [];
    expect(first).toMatchObject({
      title: newest[0]?.title,
      tone: newest[0]?.category,
      image: null,
    });
    expect(first?.meta).toMatch(/^Security · [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });

  it('words the three newest posts with the reading time and the cover', async () => {
    const latest = await loadLatest(createNewsApi(news.url), createBlogApi(blog.url));
    expect(latest.blog?.map((entry) => entry.href)).toEqual(
      FIXTURE_POSTS.slice(0, LATEST_COUNT).map((post) => `/blog/${post.slug}`),
    );
    const [first] = latest.blog ?? [];
    expect(first?.meta).toMatch(/ · \d+ min read$/);
    expect(first?.image).toBe(FIXTURE_POSTS[0]?.coverImage?.url);
  });

  it('keeps one list when only the other API read fails', async () => {
    const latest = await loadLatest(createNewsApi(DEAD), createBlogApi(blog.url));
    expect(latest.news).toBeNull();
    expect(latest.blog).toHaveLength(LATEST_COUNT);
  });
});

describe('postTone', () => {
  it('gives a slug the same tint every time', () => {
    expect(postTone('relay-budgets-and-estimates')).toBe(postTone('relay-budgets-and-estimates'));
  });
});

describe('GET /nav/latest.json', () => {
  const call = () => GET({} as APIContext) as Promise<Response>;
  const previous = process.env.WEBSITE_API_INTERNAL_URL;
  let api: Server;

  beforeAll(async () => {
    // One server answers both reads, as the real API does.
    api = createServer((request, reply) => {
      if (!handleNewsRequest(request, reply) && !handleBlogRequest(request, reply)) {
        reply.writeHead(404).end();
      }
    });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
  });

  afterAll(async () => {
    process.env.WEBSITE_API_INTERNAL_URL = previous;
    await new Promise((resolve) => api.close(resolve));
  });

  it('answers with both lists, cached for a minute and kept out of search', async () => {
    process.env.WEBSITE_API_INTERNAL_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const response = await call();
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe(CACHE.list);
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    const body = await response.json();
    expect(body.news).toHaveLength(LATEST_COUNT);
    expect(body.blog).toHaveLength(LATEST_COUNT);
  });

  it('answers with nulls and a short cache when the API is down', async () => {
    process.env.WEBSITE_API_INTERNAL_URL = DEAD;
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=15');
    expect(await response.json()).toEqual({ news: null, blog: null });
  });
});
