import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { APIContext } from 'astro';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGE_SIZE as BLOG_PAGE_SIZE } from '../src/lib/blog/page';
import { PAGE_SIZE as NEWS_PAGE_SIZE } from '../src/lib/news/page';
import { GET } from '../src/pages/sitemap-dynamic.xml';
import { FIXTURE_POSTS, type FixturePost } from './fixtures/blog/posts';
import { FIXTURE_NEWS } from './fixtures/news/items';
import { handleBlogRequest } from './helpers/fakeBlogApi';
import { handleNewsRequest } from './helpers/fakeNewsApi';

const SITE = 'https://runovahq.com';
const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

interface FakeApi {
  url: string;
  close: () => Promise<void>;
}

/** The blog and news reads of the API on one origin, as the site sees it. */
async function startFakeApi(options: { status?: number; posts?: FixturePost[] } = {}) {
  const server: Server = createServer((request, reply) => {
    if (handleBlogRequest(request, reply, options) || handleNewsRequest(request, reply, options)) {
      return;
    }
    reply.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  } satisfies FakeApi;
}

let api: FakeApi;
let manyPosts: FakeApi;
let unavailable: FakeApi;

// Enough posts for several list pages and a tag with a second page.
const MANY_POSTS: FixturePost[] = Array.from({ length: 25 }, (_, index) => ({
  ...FIXTURE_POSTS[index % FIXTURE_POSTS.length],
  id: 1_000 + index,
  slug: `post-number-${index + 1}`,
  tags: [{ slug: 'relay', name: 'Relay' }],
}));

beforeAll(async () => {
  api = await startFakeApi();
  manyPosts = await startFakeApi({ posts: MANY_POSTS });
  unavailable = await startFakeApi({ status: 503 });
});

afterAll(async () => {
  await Promise.all([api, manyPosts, unavailable].map((each) => each?.close()));
});

async function sitemap(apiUrl: string): Promise<Response> {
  process.env.WEBSITE_API_INTERNAL_URL = apiUrl;
  const url = new URL('/sitemap-dynamic.xml', SITE);
  return GET({
    site: new URL(SITE),
    url,
    request: new Request(url),
    params: {},
  } as unknown as APIContext);
}

type Entry = { loc: string; lastmod?: string };

function entries(xml: string): Entry[] {
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' }).parse(xml);
  expect(parsed.urlset['@xmlns']).toBe(SITEMAP_NS);
  const url = parsed.urlset.url ?? [];
  return Array.isArray(url) ? url : [url];
}

const locs = (list: Entry[]) => list.map((entry) => entry.loc);

describe('/sitemap-dynamic.xml', () => {
  it('is a well-formed sitemap cached for ten minutes', async () => {
    const response = await sitemap(api.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=600');
    expect(XMLValidator.validate(await response.text())).toBe(true);
  });

  it('lists every post with its last change', async () => {
    const list = entries(await (await sitemap(api.url)).text());
    for (const post of FIXTURE_POSTS) {
      expect(list).toContainEqual({
        loc: `${SITE}/blog/${post.slug}`,
        lastmod: new Date(post.updatedAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      });
    }
  });

  it('lists every news item with its last change', async () => {
    const list = entries(await (await sitemap(api.url)).text());
    for (const item of FIXTURE_NEWS) {
      expect(list).toContainEqual({
        loc: `${SITE}/news/${item.slug}`,
        lastmod: new Date(item.updatedAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      });
    }
  });

  it('lists every tag page', async () => {
    const list = locs(entries(await (await sitemap(api.url)).text()));
    const tags = new Set(FIXTURE_POSTS.flatMap((post) => post.tags.map((tag) => tag.slug)));
    for (const tag of tags) expect(list).toContain(`${SITE}/blog/tags/${tag}`);
  });

  it('lists the later pages of the blog, of a tag and of the news', async () => {
    const list = locs(entries(await (await sitemap(manyPosts.url)).text()));
    const blogPages = Math.ceil(MANY_POSTS.length / BLOG_PAGE_SIZE);
    expect(blogPages).toBe(3);
    expect(list).toContain(`${SITE}/blog/page/2`);
    expect(list).toContain(`${SITE}/blog/page/3`);
    expect(list).not.toContain(`${SITE}/blog/page/4`);
    expect(list).toContain(`${SITE}/blog/tags/relay/page/3`);
    expect(list).not.toContain(`${SITE}/blog/tags/relay/page/4`);

    const newsPages = Math.ceil(FIXTURE_NEWS.length / NEWS_PAGE_SIZE);
    const newsList = locs(entries(await (await sitemap(api.url)).text()));
    for (let page = 2; page <= newsPages; page++) {
      expect(newsList).toContain(`${SITE}/news?page=${page}`);
    }
    expect(newsList).not.toContain(`${SITE}/news?page=${newsPages + 1}`);
  });

  it('leaves out the first list pages the static sitemap already has, and anything private', async () => {
    const list = locs(entries(await (await sitemap(manyPosts.url)).text()));
    expect(list).not.toContain(`${SITE}/blog`);
    expect(list).not.toContain(`${SITE}/news`);
    expect(list).not.toContain(`${SITE}/blog/page/1`);
    expect(list.filter((loc) => /\/(admin|api)(\/|$)/.test(new URL(loc).pathname))).toEqual([]);
    expect(new Set(list).size).toBe(list.length);
  });

  it('answers 503 with Retry-After and no cache when the API is down', async () => {
    const response = await sitemap(unavailable.url);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('60');
  });
});
