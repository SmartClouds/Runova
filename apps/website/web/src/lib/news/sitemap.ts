import { escapeXml } from '../blog/rss';
import { SITE_NAME } from '../seo';
import type { ApiResult } from '../websiteApi';
import type { NewsApi, NewsListItem } from './api';

/**
 * The Google News sitemap: the items published in the last two days, at most 1,000 of them
 * (https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap).
 */

export const NEWS_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
export const MAX_URLS = 1_000;

/** The API's largest page. */
const API_PAGE_SIZE = 100;

/** A W3C datetime without milliseconds, such as "2026-10-29T08:00:00Z". */
function w3cTime(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function url(site: string | URL, item: NewsListItem): string {
  return [
    '<url>',
    `<loc>${escapeXml(new URL(`/news/${item.slug}`, site).href)}</loc>`,
    '<news:news>',
    `<news:publication><news:name>${escapeXml(SITE_NAME)}</news:name><news:language>en</news:language></news:publication>`,
    `<news:publication_date>${w3cTime(item.publishedAt)}</news:publication_date>`,
    `<news:title>${escapeXml(item.title)}</news:title>`,
    '</news:news>',
    '</url>',
  ].join('');
}

/** The sitemap of `items` (newest first), leaving out any published before the window. */
export function newsSitemap(site: string | URL, items: NewsListItem[], now = new Date()): string {
  const since = now.getTime() - NEWS_WINDOW_MS;
  const recent = items.filter((item) => Date.parse(item.publishedAt) >= since).slice(0, MAX_URLS);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">',
    ...recent.map((item) => url(site, item)),
    '</urlset>',
  ].join('\n');
}

/** Every item published in the window before `now`, newest first, up to the sitemap's limit. */
export async function recentNews(
  api: NewsApi,
  now = new Date(),
): Promise<ApiResult<NewsListItem[]>> {
  const since = new Date(now.getTime() - NEWS_WINDOW_MS);
  const items: NewsListItem[] = [];
  for (let page = 1; items.length < MAX_URLS; page++) {
    const result = await api.listNews({ since, page, pageSize: API_PAGE_SIZE });
    if (!result.ok) return result;
    items.push(...result.value.items);
    if (page >= result.value.totalPages) break;
  }
  return { ok: true, value: items.slice(0, MAX_URLS) };
}
