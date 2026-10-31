import type { BlogApi } from './blog/api';
import { PAGE_SIZE as BLOG_PAGE_SIZE, pagePath } from './blog/page';
import { escapeXml } from './blog/rss';
import type { NewsApi } from './news/api';
import { PAGE_SIZE as NEWS_PAGE_SIZE } from './news/page';
import type { ApiResult } from './websiteApi';

/**
 * The dynamic part of the sitemap index: the blog and news URLs read from the API. The first
 * pages of /blog and /news are routes Astro knows, so the static sitemap already lists them.
 */

/** The Cache-Control of the sitemaps, from docs/epics/40-website.md. */
export const SITEMAP_CACHE = 'public, max-age=600';

/** The most URLs one sitemap file may hold (https://www.sitemaps.org/protocol.html). */
export const MAX_SITEMAP_URLS = 50_000;

/** The API's largest page. */
const API_PAGE_SIZE = 100;

export interface SitemapUrl {
  path: string;
  /** When the page last changed, as an ISO time. */
  lastmod?: string;
}

/** A W3C datetime without milliseconds, such as "2026-10-29T08:00:00Z". */
export function w3cTime(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A `<urlset>` of `urls` on `site`, cut at the protocol's limit. */
export function urlset(site: string | URL, urls: SitemapUrl[]): string {
  const entries = urls.slice(0, MAX_SITEMAP_URLS).map(({ path, lastmod }) => {
    const loc = `<loc>${escapeXml(new URL(path, site).href)}</loc>`;
    return `<url>${loc}${lastmod ? `<lastmod>${w3cTime(lastmod)}</lastmod>` : ''}</url>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    '</urlset>',
  ].join('\n');
}

/** Pages 2 to the last of a list of `total` items shown `pageSize` at a time. */
function laterPages(total: number, pageSize: number): number[] {
  const pages = Math.ceil(total / pageSize);
  return Array.from({ length: Math.max(pages - 1, 0) }, (_, index) => index + 2);
}

/** Reads every page of a paged API list, up to the sitemap's limit. */
async function readAll<T>(
  read: (
    page: number,
  ) => Promise<ApiResult<{ items: T[]; totalItems: number; totalPages: number }>>,
): Promise<ApiResult<{ items: T[]; totalItems: number }>> {
  const items: T[] = [];
  let totalItems = 0;
  for (let page = 1; items.length < MAX_SITEMAP_URLS; page++) {
    const result = await read(page);
    if (!result.ok) return result;
    items.push(...result.value.items);
    totalItems = result.value.totalItems;
    if (page >= result.value.totalPages) break;
  }
  return { ok: true, value: { items, totalItems } };
}

/** Every blog and news URL the API knows of besides the first list pages. */
export async function dynamicUrls(blog: BlogApi, news: NewsApi): Promise<ApiResult<SitemapUrl[]>> {
  const [posts, tags, items] = await Promise.all([
    readAll((page) => blog.listPosts({ page, pageSize: API_PAGE_SIZE })),
    blog.listTags(),
    readAll((page) => news.listNews({ page, pageSize: API_PAGE_SIZE })),
  ]);
  if (!posts.ok) return posts;
  if (!tags.ok) return tags;
  if (!items.ok) return items;

  const urls: SitemapUrl[] = [
    ...laterPages(posts.value.totalItems, BLOG_PAGE_SIZE).map((page) => ({
      path: pagePath('/blog', page),
    })),
    ...posts.value.items.map((post) => ({ path: `/blog/${post.slug}`, lastmod: post.updatedAt })),
    ...tags.value
      .filter((tag) => tag.postCount > 0)
      .flatMap((tag) => {
        const base = `/blog/tags/${tag.slug}`;
        return [1, ...laterPages(tag.postCount, BLOG_PAGE_SIZE)].map((page) => ({
          path: pagePath(base, page),
        }));
      }),
    ...laterPages(items.value.totalItems, NEWS_PAGE_SIZE).map((page) => ({
      path: `/news?page=${page}`,
    })),
    ...items.value.items.map((item) => ({ path: `/news/${item.slug}`, lastmod: item.updatedAt })),
  ];
  return { ok: true, value: urls };
}
