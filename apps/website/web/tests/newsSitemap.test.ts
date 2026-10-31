import type { APIContext } from 'astro';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newsSitemap } from '../src/lib/news/sitemap';
import { GET } from '../src/pages/news-sitemap.xml';
import { FIXTURE_NEWS, FIXTURE_NOW, hoursAgo } from './fixtures/news/items';
import { type FakeNewsApi, startFakeNewsApi } from './helpers/fakeNewsApi';

const SITE = 'https://runovahq.com';
const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const NEWS_NS = 'http://www.google.com/schemas/sitemap-news/0.9';
const TWO_DAYS = 2 * 24 * 3_600_000;

let api: FakeNewsApi;
let unavailable: FakeNewsApi;

beforeAll(async () => {
  api = await startFakeNewsApi();
  unavailable = await startFakeNewsApi({ status: 503 });
});

afterAll(async () => {
  await api?.close();
  await unavailable?.close();
});

async function sitemap(apiUrl: string): Promise<Response> {
  process.env.WEBSITE_API_INTERNAL_URL = apiUrl;
  const url = new URL('/news-sitemap.xml', SITE);
  return GET({
    site: new URL(SITE),
    url,
    request: new Request(url),
    params: {},
  } as unknown as APIContext);
}

type UrlEntry = {
  loc: string;
  'news:news': {
    'news:publication': { 'news:name': string; 'news:language': string };
    'news:publication_date': string;
    'news:title': string;
  };
};

function entries(xml: string): UrlEntry[] {
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' }).parse(xml);
  const url = parsed.urlset?.url ?? [];
  return Array.isArray(url) ? url : [url];
}

const recent = FIXTURE_NEWS.filter(
  (item) => FIXTURE_NOW - Date.parse(item.publishedAt) <= TWO_DAYS,
);

describe('/news-sitemap.xml', () => {
  it('is a well-formed Google News sitemap', async () => {
    const response = await sitemap(api.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const xml = await response.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(XMLValidator.validate(xml)).toBe(true);
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' }).parse(xml);
    expect(parsed.urlset['@xmlns']).toBe(SITEMAP_NS);
    expect(parsed.urlset['@xmlns:news']).toBe(NEWS_NS);
  });

  it('lists only the items published in the last two days, newest first', async () => {
    expect(recent.length).toBe(6);
    const xml = await (await sitemap(api.url)).text();
    expect(entries(xml).map((entry) => entry.loc)).toEqual(
      recent.map((item) => `${SITE}/news/${item.slug}`),
    );
    const asked = api.requests.findLast((request) => request.startsWith('/api/v1/news?'));
    const since = new URL(asked ?? '', 'http://fake').searchParams.get('since');
    expect(since).not.toBeNull();
    expect(Math.abs(Date.now() - TWO_DAYS - Date.parse(since ?? ''))).toBeLessThan(60_000);
  });

  it('gives each item its publication, language, date and title', async () => {
    const xml = await (await sitemap(api.url)).text();
    const [first] = entries(xml);
    expect(first['news:news']).toEqual({
      'news:publication': { 'news:name': 'Runova', 'news:language': 'en' },
      'news:publication_date': recent[0].publishedAt.replace(/\.\d{3}Z$/, 'Z'),
      'news:title': recent[0].title,
    });
  });

  it('answers 503 with Retry-After when the API is down', async () => {
    const response = await sitemap(unavailable.url);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('newsSitemap', () => {
  const now = new Date(FIXTURE_NOW);

  it('leaves out anything older than two days, whatever it is given', () => {
    const xml = newsSitemap(SITE, FIXTURE_NEWS, now);
    expect(entries(xml).map((entry) => entry.loc)).toEqual(
      recent.map((item) => `${SITE}/news/${item.slug}`),
    );
  });

  it('is an empty urlset when nothing is that new', () => {
    const xml = newsSitemap(SITE, FIXTURE_NEWS.slice(6), now);
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(entries(xml)).toEqual([]);
  });

  it('escapes titles', () => {
    const item = {
      ...FIXTURE_NEWS[0],
      title: 'Fixes for <sshd> & "scp"',
      publishedAt: hoursAgo(1),
    };
    const xml = newsSitemap(SITE, [item], now);
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(entries(xml)[0]['news:news']['news:title']).toBe('Fixes for <sshd> & "scp"');
    expect(xml).toContain('<news:title>Fixes for &lt;sshd&gt; &amp; &quot;scp&quot;</news:title>');
  });

  it('lists at most the 1,000 items Google reads from one news sitemap', () => {
    const many = Array.from({ length: 1_005 }, (_, index) => ({
      ...FIXTURE_NEWS[0],
      slug: `item-${index}`,
      publishedAt: hoursAgo(index / 100),
    }));
    expect(entries(newsSitemap(SITE, many, now)).length).toBe(1_000);
  });
});
