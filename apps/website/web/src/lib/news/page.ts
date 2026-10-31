import type { NewsArticle } from 'schema-dts';
import { DEFAULT_OG_IMAGE, headline, organizationId } from '../seo';
import {
  type AffectedTechnology,
  CATEGORIES,
  type Category,
  type NewsApi,
  type NewsItem,
  type NewsListItem,
  type NewsPage,
  SEVERITIES,
  type Severity,
} from './api';

/** Items per list page. */
export const PAGE_SIZE = 20;

/** The Cache-Control of each news route, from docs/epics/40-website.md. */
export const CACHE = {
  list: 'public, max-age=60, stale-while-revalidate=300',
  item: 'public, max-age=300, stale-while-revalidate=600',
  feed: 'public, max-age=300, stale-while-revalidate=600',
  sitemap: 'public, max-age=300',
} as const;

export const CATEGORY_LABELS: Record<Category, string> = {
  security: 'Security',
  release: 'Release',
  deprecation: 'Deprecation',
  'end-of-life': 'End of life',
  ai: 'AI',
  tooling: 'Tooling',
  industry: 'Industry',
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  info: 'Info',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

/** The filters of a `/news` URL. */
export interface NewsFilters {
  categories: Category[];
  severities: Severity[];
}

/**
 * The filters in a query string, in the API's order and without repeats. Values the API does not
 * know are dropped, so an old or mistyped link still shows news instead of an error.
 */
export function parseFilters(query: URLSearchParams): NewsFilters {
  const categories = new Set(query.getAll('category'));
  const severities = new Set(query.getAll('severity'));
  return {
    categories: CATEGORIES.filter((category) => categories.has(category)),
    severities: SEVERITIES.filter((severity) => severities.has(severity)),
  };
}

export const hasFilters = (filters: NewsFilters) =>
  filters.categories.length > 0 || filters.severities.length > 0;

/** The `/news` URL of `filters` at `page`, with the query in the same order the form submits it. */
export function newsListPath(filters: NewsFilters, page = 1): string {
  const query = new URLSearchParams();
  for (const category of filters.categories) query.append('category', category);
  for (const severity of filters.severities) query.append('severity', severity);
  if (page > 1) query.set('page', String(page));
  const search = query.toString();
  return search ? `/news?${search}` : '/news';
}

export type ListResult =
  | { state: 'ok'; filters: NewsFilters; page: NewsPage }
  | { state: 'not-found' | 'unavailable' };

/**
 * One page of `/news` for the query string `query`. A `page` that is not a whole number from 1, or
 * one past the end, is not found; an empty first page is still a page.
 */
export async function loadNewsList(api: NewsApi, query: URLSearchParams): Promise<ListResult> {
  const filters = parseFilters(query);
  const pageParam = query.get('page');
  const page = pageParam === null ? 1 : /^[1-9]\d*$/.test(pageParam) ? Number(pageParam) : null;
  if (page === null) return { state: 'not-found' };

  const result = await api.listNews({ ...filters, page, pageSize: PAGE_SIZE });
  if (!result.ok) return { state: result.reason };
  if (page > Math.max(result.value.totalPages, 1)) return { state: 'not-found' };
  return { state: 'ok', filters, page: result.value };
}

/** The title and meta description of a list page. Filtered pages share them; their canonical is /news. */
export function listMeta(filters: NewsFilters, page: number, totalPages: number) {
  const named = [
    ...filters.categories.map((category) => CATEGORY_LABELS[category]),
    ...filters.severities.map((severity) => `${SEVERITY_LABELS[severity]} severity`),
  ];
  const base = named.length > 0 ? `News: ${named.join(', ')}` : 'Technology news';
  const paged = page > 1 ? ` Page ${page} of ${totalPages}.` : '';
  return {
    title: page > 1 ? `${base}, page ${page}` : base,
    description: `Security advisories, releases and end-of-life dates for the tools developers use, with the versions affected and what to update to.${paged}`,
  };
}

/** One step a reader takes for one affected technology of a security item. */
export function updateStep({ name, fixedIn }: AffectedTechnology): string {
  return fixedIn
    ? `Update ${name} to ${fixedIn} or later.`
    : `No fixed version of ${name} is out yet. Follow the sources below and update once it is.`;
}

/** The steps for a security item: one per technology and fix, without repeats. */
export function updateSteps(item: NewsListItem): string[] {
  return [...new Set(item.technologies.map(updateStep))];
}

/** The page of a CVE id on cve.org. */
export function cveUrl(id: string): string {
  return `https://www.cve.org/CVERecord?id=${encodeURIComponent(id)}`;
}

/** The NewsArticle node of an item page, written and published by the site's Organization. */
export function newsArticle(site: string | URL, item: NewsItem): NewsArticle {
  const url = new URL(`/news/${item.slug}`, site).href;
  return {
    '@type': 'NewsArticle',
    '@id': `${url}#article`,
    headline: headline(item.title),
    description: item.summary,
    datePublished: item.publishedAt,
    dateModified: item.updatedAt,
    author: { '@id': organizationId(site) },
    image: [new URL(DEFAULT_OG_IMAGE.path, site).href],
    url,
    mainEntityOfPage: url,
    articleSection: CATEGORY_LABELS[item.category],
    ...(item.tags.length > 0 ? { keywords: item.tags.join(', ') } : {}),
    inLanguage: 'en',
    publisher: { '@id': organizationId(site) },
    isPartOf: { '@id': new URL('/#website', site).href },
  };
}
