import { fileURLToPath } from 'node:url';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { type BuiltPage, builtPages, seoProblems } from '../scripts/seoCheck';

// Crawls the production build the way a search engine would: from the sitemap index through every
// sitemap it lists, static pages and the blog and news pages the fake API serves.

const clientDir = fileURLToPath(new URL('../dist/client', import.meta.url));
const SITE = process.env.SITE_URL || 'https://runovahq.com';

function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1].replace(/&amp;/g, '&'));
}

/** The site-relative path and query of a sitemap URL, which names the production origin. */
function local(url: string): string {
  const parsed = new URL(url);
  expect(parsed.origin, url).toBe(new URL(SITE).origin);
  return `${parsed.pathname}${parsed.search}`;
}

async function text(request: APIRequestContext, path: string): Promise<string> {
  const response = await request.get(path, { maxRedirects: 0 });
  expect(response.status(), path).toBe(200);
  return response.text();
}

/** Every page URL in every sitemap the index lists, as local paths. */
async function sitemapPages(request: APIRequestContext): Promise<string[]> {
  const sitemaps = locs(await text(request, '/sitemap-index.xml')).map(local);
  expect(sitemaps).toEqual(
    expect.arrayContaining(['/sitemap-0.xml', '/sitemap-dynamic.xml', '/news-sitemap.xml']),
  );
  const pages = new Set<string>();
  for (const sitemap of sitemaps) {
    for (const url of locs(await text(request, sitemap))) pages.add(local(url));
  }
  return [...pages];
}

test.describe('the sitemap index', () => {
  test.describe.configure({ timeout: 120_000 });

  let pages: string[];
  let crawled: BuiltPage[];

  test.beforeAll(async ({ request }) => {
    pages = await sitemapPages(request);
    crawled = [];
    for (const path of pages) crawled.push({ path, html: await text(request, path) });
  });

  test('lists no admin or API URL', () => {
    expect(pages.length).toBeGreaterThan(70);
    for (const path of pages) expect(path).not.toMatch(/^\/(admin|api|hangfire)(\/|$|\?)/);
  });

  test('lists every built page, and the blog, news and download pages', () => {
    const built = builtPages(clientDir).map((page) => page.path);
    expect(pages).toEqual(expect.arrayContaining([...built, '/blog', '/news', '/download']));
    expect(pages.some((path) => /^\/blog\/[^/]+$/.test(path) && path !== '/blog/rss.xml')).toBe(
      true,
    );
    expect(pages.some((path) => /^\/news\/[^/?]+$/.test(path))).toBe(true);
  });

  test('every page it lists answers 200 with unique metadata and valid JSON-LD', () => {
    expect(seoProblems(crawled)).toEqual([]);
  });

  test('every page it lists is its own canonical URL', () => {
    for (const { path, html } of crawled) {
      const canonical = /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1];
      expect(canonical, path).toBe(new URL(path, SITE).href);
    }
  });
});

test.describe('crawl rules', () => {
  test('robots.txt keeps crawlers out of the admin and API and names both sitemaps', async ({
    request,
  }) => {
    const robots = await text(request, '/robots.txt');
    expect(robots).toMatch(/^Disallow: \/admin$/m);
    expect(robots).toMatch(/^Disallow: \/api\/$/m);
    expect(robots).toContain(`Sitemap: ${new URL('/sitemap-index.xml', SITE).href}`);
    expect(robots).toContain(`Sitemap: ${new URL('/news-sitemap.xml', SITE).href}`);
  });

  test('llms.txt links the main sections', async ({ request }) => {
    const llms = await text(request, '/llms.txt');
    expect(llms).toMatch(/^# Runova$/m);
    for (const path of ['/features', '/help', '/download', '/blog', '/news']) {
      expect(llms).toContain(`(${new URL(path, SITE).href})`);
    }
  });

  for (const path of ['/features/', '/help/relay/', '/blog/', '/news/', '/download/']) {
    test(`${path} redirects to the URL without the trailing slash`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect([301, 308]).toContain(response.status());
      expect(new URL(response.headers().location ?? '', 'http://x').pathname).toBe(
        path.slice(0, -1),
      );
    });
  }
});
