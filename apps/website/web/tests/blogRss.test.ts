import type { APIContext } from 'astro';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET } from '../src/pages/blog/rss.xml';
import { FIXTURE_POSTS } from './fixtures/blog/posts';
import { type FakeBlogApi, startFakeBlogApi } from './helpers/fakeBlogApi';

const SITE = 'https://runovahq.com';
/** RFC 822 dates as RSS 2.0 wants them, with a four-digit year and GMT. */
const RFC_822 =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

let api: FakeBlogApi;
let awkward: FakeBlogApi;
let unavailable: FakeBlogApi;

beforeAll(async () => {
  api = await startFakeBlogApi();
  awkward = await startFakeBlogApi({
    posts: [
      {
        ...FIXTURE_POSTS[1],
        title: 'Tips & tricks for <agents> that "write" code',
        excerpt: 'Ampersands & angle brackets <b>stay</b> text, and so does ]]> in an excerpt.',
      },
    ],
  });
  unavailable = await startFakeBlogApi({ status: 503 });
});

afterAll(async () => {
  await api?.close();
  await awkward?.close();
  await unavailable?.close();
});

async function feed(apiUrl: string): Promise<Response> {
  process.env.WEBSITE_API_INTERNAL_URL = apiUrl;
  const url = new URL('/blog/rss.xml', SITE);
  return GET({
    site: new URL(SITE),
    url,
    request: new Request(url),
    params: {},
  } as unknown as APIContext);
}

type Item = Record<string, unknown> & { guid: Record<string, unknown> };

function parse(xml: string) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });
  return parser.parse(xml);
}

describe('/blog/rss.xml', () => {
  it('is well-formed XML with an RSS 2.0 channel', async () => {
    const response = await feed(api.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8');
    const xml = await response.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(XMLValidator.validate(xml)).toBe(true);

    const { rss } = parse(xml);
    expect(rss['@version']).toBe('2.0');
    const channel = rss.channel;
    expect(channel.title).toBe('Runova blog');
    expect(channel.link).toBe(`${SITE}/blog`);
    expect(typeof channel.description).toBe('string');
    expect(channel.description.length).toBeGreaterThan(0);
    expect(channel.language).toBe('en');
    expect(channel.lastBuildDate).toMatch(RFC_822);
    expect(channel['atom:link']).toMatchObject({
      '@href': `${SITE}/blog/rss.xml`,
      '@rel': 'self',
      '@type': 'application/rss+xml',
    });
    expect(rss['@xmlns:atom']).toBe('http://www.w3.org/2005/Atom');
  });

  it('lists the latest twenty posts, newest first', async () => {
    const { rss } = parse(await (await feed(api.url)).text());
    const items = rss.channel.item as Item[];
    expect(items.map((item) => item.link)).toEqual(
      FIXTURE_POSTS.slice(0, 20).map((post) => `${SITE}/blog/${post.slug}`),
    );
    const [first] = items;
    const post = FIXTURE_POSTS[0];
    expect(first.title).toBe(post.title);
    expect(first.description).toBe(post.excerpt);
    expect(first.pubDate).toBe('Fri, 30 Oct 2026 09:00:00 GMT');
    expect(first.guid).toEqual({ '#text': `${SITE}/blog/${post.slug}`, '@isPermaLink': 'true' });
    expect(first['dc:creator']).toBe(post.author.displayName);
    expect(first.category).toEqual(['Agents', 'Relay']);
    for (const item of items) {
      expect(item.pubDate).toMatch(RFC_822);
    }
  });

  it('escapes titles and excerpts so the feed stays valid', async () => {
    const xml = await (await feed(awkward.url)).text();
    expect(XMLValidator.validate(xml)).toBe(true);
    const item = parse(xml).rss.channel.item as Item;
    expect(item.title).toBe('Tips & tricks for <agents> that "write" code');
    expect(item.description).toBe(
      'Ampersands & angle brackets <b>stay</b> text, and so does ]]> in an excerpt.',
    );
    expect(xml).toContain('<title>Tips &amp; tricks for &lt;agents&gt;');
  });

  it('sends the feed Cache-Control', async () => {
    const response = await feed(api.url);
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=600, stale-while-revalidate=600',
    );
  });

  it('answers 503 with Retry-After when the API is down', async () => {
    const response = await feed(unavailable.url);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
