import type { APIContext } from 'astro';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET } from '../src/pages/news/rss.xml';
import { BY_SEVERITY, FIXTURE_NEWS } from './fixtures/news/items';
import { type FakeNewsApi, startFakeNewsApi } from './helpers/fakeNewsApi';

const SITE = 'https://runovahq.com';
const RFC_822 =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

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

async function feed(apiUrl: string): Promise<Response> {
  process.env.WEBSITE_API_INTERNAL_URL = apiUrl;
  const url = new URL('/news/rss.xml', SITE);
  return GET({
    site: new URL(SITE),
    url,
    request: new Request(url),
    params: {},
  } as unknown as APIContext);
}

type Item = Record<string, unknown> & { guid: Record<string, unknown>; category: unknown };

function channel(xml: string) {
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' }).parse(xml).rss
    .channel;
}

describe('/news/rss.xml', () => {
  it('is well-formed RSS 2.0 with the item Cache-Control', async () => {
    const response = await feed(api.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=300, stale-while-revalidate=600',
    );
    const xml = await response.text();
    expect(XMLValidator.validate(xml)).toBe(true);
    const { title, link, language, lastBuildDate } = channel(xml);
    expect(title).toBe('Runova news');
    expect(link).toBe(`${SITE}/news`);
    expect(language).toBe('en');
    expect(lastBuildDate).toMatch(RFC_822);
  });

  it('lists the newest twenty items with their links, summary, date and category', async () => {
    const xml = await (await feed(api.url)).text();
    const items = channel(xml).item as Item[];
    expect(items.map((item) => item.link)).toEqual(
      FIXTURE_NEWS.slice(0, 20).map((item) => `${SITE}/news/${item.slug}`),
    );
    const first = items[0];
    expect(first.title).toBe(FIXTURE_NEWS[0].title);
    expect(first.description).toBe(FIXTURE_NEWS[0].summary);
    expect(first.pubDate).toBe(new Date(FIXTURE_NEWS[0].publishedAt).toUTCString());
    expect(first.guid).toEqual({ '#text': first.link, '@isPermaLink': 'true' });
    expect(first.category).toEqual(['Security', 'High severity']);
  });

  it('names no severity for info items', async () => {
    const xml = await (await feed(api.url)).text();
    const item = (channel(xml).item as Item[]).find(
      (each) => each.link === `${SITE}/news/${BY_SEVERITY.info.slug}`,
    );
    expect(item?.category).toBe('Release');
  });

  it('answers 503 with Retry-After when the API is down', async () => {
    const response = await feed(unavailable.url);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
