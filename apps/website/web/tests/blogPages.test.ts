import { loadRenderers } from 'astro:container';
import { getContainerRenderer as reactRenderer } from '@astrojs/react/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import NotFoundPage from '../src/pages/404.astro';
import Post from '../src/pages/blog/[slug].astro';
import BlogIndex from '../src/pages/blog/index.astro';
import BlogPage from '../src/pages/blog/page/[page].astro';
import TagIndex from '../src/pages/blog/tags/[tag]/index.astro';
import TagPage from '../src/pages/blog/tags/[tag]/page/[page].astro';
import { FIXTURE_POSTS } from './fixtures/blog/posts';
import { type FakeBlogApi, startFakeBlogApi } from './helpers/fakeBlogApi';
import { deadApiUrl } from './helpers/fakeReleaseApi';
import { scanHtml } from './helpers/textScan';

const LIST_CACHE = 'public, max-age=60, stale-while-revalidate=300';
const POST_CACHE = 'public, max-age=300, stale-while-revalidate=600';

type Page = Parameters<AstroContainer['renderToResponse']>[0];

let container: AstroContainer;
let api: FakeBlogApi;
let unavailable: FakeBlogApi;

beforeAll(async () => {
  container = await AstroContainer.create({
    renderers: await loadRenderers([reactRenderer()]),
    astroConfig: { site: 'https://runovahq.com' },
  });
  api = await startFakeBlogApi();
  unavailable = await startFakeBlogApi({ status: 503 });
});

afterAll(async () => {
  await api?.close();
  await unavailable?.close();
});

interface Rendered {
  response: Response;
  html: string;
}

async function render(
  page: Page,
  path: string,
  params: Record<string, string> = {},
  apiUrl = api.url,
): Promise<Rendered> {
  process.env.WEBSITE_API_INTERNAL_URL = apiUrl;
  const response = await container.renderToResponse(page, {
    request: new Request(`https://runovahq.com${path}`),
    params,
  });
  return { response, html: await response.text() };
}

/** The slugs of the post cards on a list page, in order. */
function cardSlugs(html: string): string[] {
  return [...html.matchAll(/<article\b[^>]*\bdata-post-card="([^"]*)"/g)].map((match) => match[1]);
}

/** The pager's link for `rel`, or undefined. */
function pagerLink(html: string, rel: 'prev' | 'next'): string | undefined {
  const nav = /<nav\b[^>]*aria-label="Pagination"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
  for (const match of nav.matchAll(/<a\b([^>]*)>/g)) {
    if (new RegExp(`\\brel="${rel}"`).test(match[1])) {
      return /\bhref="([^"]*)"/.exec(match[1])?.[1];
    }
  }
  return undefined;
}

function canonical(html: string): string | undefined {
  return /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1];
}

function meta(html: string, property: string): string | undefined {
  return new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`).exec(html)?.[1];
}

function heading(html: string): string {
  return (/<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? '').replace(/<[^>]*>/g, '').trim();
}

/** The page's main content, which a not-found blog page shares with the site's 404 page. */
function main(html: string): string {
  return /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1].trim() ?? '';
}

const newest = (from: number, to: number) => FIXTURE_POSTS.slice(from, to).map((post) => post.slug);

describe('/blog', () => {
  it('lists the newest ten posts with a link to the next page', async () => {
    const { response, html } = await render(BlogIndex, '/blog');
    expect(response.status).toBe(200);
    expect(cardSlugs(html)).toEqual(newest(0, 10));
    expect(pagerLink(html, 'prev')).toBeUndefined();
    expect(pagerLink(html, 'next')).toBe('/blog/page/2');
    expect(canonical(html)).toBe('https://runovahq.com/blog');
    expect(api.requests).toContain('/api/v1/posts?page=1&pageSize=10');
  });

  it('shows the title, excerpt, author, date, reading time and tags of each post', async () => {
    const { html } = await render(BlogIndex, '/blog');
    const post = FIXTURE_POSTS[0];
    const start = html.indexOf(`data-post-card="${post.slug}"`);
    const card = html.slice(start, html.indexOf('</article>', start));
    expect(card).toContain(`href="/blog/${post.slug}"`);
    expect(card).toContain(post.title);
    expect(card).toContain(post.excerpt);
    expect(card).toContain(post.author.displayName);
    expect(card).toContain('datetime="2026-10-30T09:00:00.000Z"');
    expect(card).toContain('October 30, 2026');
    expect(card).toContain('6 min read');
    expect(card).toContain('href="/blog/tags/relay"');
    expect(card).toContain('href="/blog/tags/agents"');
  });

  it('sends the list Cache-Control', async () => {
    const { response } = await render(BlogIndex, '/blog');
    expect(response.headers.get('cache-control')).toBe(LIST_CACHE);
  });

  it('passes the site text scan', async () => {
    const { html } = await render(BlogIndex, '/blog');
    expect(scanHtml(html)).toEqual([]);
  });

  it('answers 503 with Retry-After and a short notice when the API is down', async () => {
    const { response, html } = await render(BlogIndex, '/blog', {}, unavailable.url);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(heading(html)).toBe('The blog could not be loaded');
    expect(meta(html, 'robots')).toBe('noindex, nofollow');
  });

  it('answers 503 when nothing listens at the API URL', async () => {
    const { response } = await render(BlogIndex, '/blog', {}, await deadApiUrl());
    expect(response.status).toBe(503);
  });
});

describe('/blog/page/<n>', () => {
  it('lists the posts of that page with links both ways', async () => {
    const { response, html } = await render(BlogPage, '/blog/page/2', { page: '2' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(LIST_CACHE);
    expect(cardSlugs(html)).toEqual(newest(10, 20));
    expect(pagerLink(html, 'prev')).toBe('/blog');
    expect(pagerLink(html, 'next')).toBe('/blog/page/3');
    expect(canonical(html)).toBe('https://runovahq.com/blog/page/2');
    expect(html).toContain('Page 2 of 3');
  });

  it('has no next link on the last page', async () => {
    const { html } = await render(BlogPage, '/blog/page/3', { page: '3' });
    expect(cardSlugs(html)).toEqual(newest(20, 23));
    expect(pagerLink(html, 'prev')).toBe('/blog/page/2');
    expect(pagerLink(html, 'next')).toBeUndefined();
  });

  it('gives each page its own title and description', async () => {
    const first = await render(BlogIndex, '/blog');
    const second = await render(BlogPage, '/blog/page/2', { page: '2' });
    expect(meta(second.html, 'og:title')).not.toBe(meta(first.html, 'og:title'));
    expect(meta(second.html, 'description')).not.toBe(meta(first.html, 'description'));
    for (const { html } of [first, second]) {
      const description = meta(html, 'description') ?? '';
      expect(description.length).toBeGreaterThanOrEqual(70);
      expect(description.length).toBeLessThanOrEqual(160);
    }
  });

  it('sends page 1 to /blog for good', async () => {
    const { response } = await render(BlogPage, '/blog/page/1', { page: '1' });
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/blog');
  });

  it('answers 404 past the last page and for a page that is not a number', async () => {
    for (const page of ['4', '0', '02', 'two']) {
      const { response } = await render(BlogPage, `/blog/page/${page}`, { page });
      expect(response.status, page).toBe(404);
    }
  });
});

describe('/blog/tags/<tag>', () => {
  it('lists only the posts with the tag, under its name', async () => {
    const { response, html } = await render(TagIndex, '/blog/tags/relay', { tag: 'relay' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(LIST_CACHE);
    expect(cardSlugs(html)).toEqual([
      'relay-hands-long-tasks-between-sessions',
      'relay-budgets-and-estimates',
    ]);
    expect(heading(html)).toBe('Posts tagged Relay');
    expect(canonical(html)).toBe('https://runovahq.com/blog/tags/relay');
    expect(pagerLink(html, 'next')).toBeUndefined();
  });

  it('pages a tag with many posts', async () => {
    const first = await render(TagIndex, '/blog/tags/release-notes', { tag: 'release-notes' });
    expect(cardSlugs(first.html)).toEqual(newest(3, 13));
    expect(pagerLink(first.html, 'next')).toBe('/blog/tags/release-notes/page/2');

    const second = await render(TagPage, '/blog/tags/release-notes/page/2', {
      tag: 'release-notes',
      page: '2',
    });
    expect(second.response.status).toBe(200);
    expect(cardSlugs(second.html)).toEqual(newest(13, 23));
    expect(pagerLink(second.html, 'prev')).toBe('/blog/tags/release-notes');
    expect(pagerLink(second.html, 'next')).toBeUndefined();
    expect(canonical(second.html)).toBe('https://runovahq.com/blog/tags/release-notes/page/2');
  });

  it('answers 404 for a tag no post has and for a page past the end', async () => {
    const unknown = await render(TagIndex, '/blog/tags/nothing', { tag: 'nothing' });
    expect(unknown.response.status).toBe(404);
    const past = await render(TagPage, '/blog/tags/relay/page/2', { tag: 'relay', page: '2' });
    expect(past.response.status).toBe(404);
  });

  it('sends page 1 of a tag to the tag', async () => {
    const { response } = await render(TagPage, '/blog/tags/relay/page/1', {
      tag: 'relay',
      page: '1',
    });
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/blog/tags/relay');
  });
});

describe('/blog/<slug>', () => {
  const post = FIXTURE_POSTS[0];

  it('renders the post body with its author, date, reading time and tags', async () => {
    const { response, html } = await render(Post, `/blog/${post.slug}`, { slug: post.slug });
    expect(response.status).toBe(200);
    expect(heading(html)).toBe(post.title);
    expect(html).toContain(post.bodyHtml);
    expect(html).toContain(post.author.displayName);
    expect(html).toContain('datetime="2026-10-30T09:00:00.000Z"');
    expect(html).toContain('6 min read');
    expect(html).toContain('href="/blog/tags/relay"');
    expect(canonical(html)).toBe(`https://runovahq.com/blog/${post.slug}`);
    expect(meta(html, 'og:type')).toBe('article');
    expect(scanHtml(html)).toEqual([]);
  });

  it('sends the post Cache-Control', async () => {
    const { response } = await render(Post, `/blog/${post.slug}`, { slug: post.slug });
    expect(response.headers.get('cache-control')).toBe(POST_CACHE);
  });

  it('links related posts that share a tag, never the post itself', async () => {
    const { html } = await render(Post, `/blog/${post.slug}`, { slug: post.slug });
    const start = html.search(/<section\b[^>]*aria-labelledby="related-heading"/);
    expect(start).toBeGreaterThan(0);
    const related = html.slice(start, html.indexOf('</section>', start));
    const links = [...related.matchAll(/href="\/blog\/([a-z0-9-]+)"/g)].map((match) => match[1]);
    expect(links[0]).toBe('relay-budgets-and-estimates');
    expect(links).not.toContain(post.slug);
    expect(new Set(links).size).toBe(3);
  });

  it('uses the cover image as the Open Graph image', async () => {
    const { html } = await render(Post, `/blog/${post.slug}`, { slug: post.slug });
    expect(meta(html, 'og:image')).toBe(post.coverImage?.url);
    expect(meta(html, 'og:image:width')).toBe('1600');
    expect(meta(html, 'og:image:height')).toBe('900');
    expect(meta(html, 'og:image:alt')).toBe(post.coverImage?.alt);
  });

  it('uses the generated image when the post has no cover', async () => {
    const plain = FIXTURE_POSTS[1];
    const { html } = await render(Post, `/blog/${plain.slug}`, { slug: plain.slug });
    expect(meta(html, 'og:image')).toBe(`https://runovahq.com/blog/${plain.slug}/og.png`);
    expect(meta(html, 'og:image:width')).toBe('1200');
    expect(meta(html, 'og:image:height')).toBe('630');
  });

  it('answers an unknown slug with 404 and the site 404 page', async () => {
    const { response, html } = await render(Post, '/blog/no-such-post', { slug: 'no-such-post' });
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const notFound = await container.renderToString(NotFoundPage, {
      request: new Request('https://runovahq.com/404'),
    });
    expect(main(html)).toBe(main(notFound));
    expect(heading(html)).toBe('Page not found');
    expect(meta(html, 'robots')).toBe('noindex, nofollow');
  });

  it('answers 404 without asking the API for a slug it could never have', async () => {
    const before = api.requests.length;
    const { response } = await render(Post, '/blog/1234', { slug: '1234' });
    expect(response.status).toBe(404);
    expect(api.requests.length).toBe(before);
  });

  it('answers 503 when the API is down', async () => {
    const { response } = await render(
      Post,
      `/blog/${post.slug}`,
      { slug: post.slug },
      unavailable.url,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
  });
});
