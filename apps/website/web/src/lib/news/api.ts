/**
 * The news reads of the website API (`GET /api/v1/news` and `/api/v1/news/{slug}`, T006). Nothing
 * is cached here: the pages send Cache-Control and the proxy in front of the site caches by it.
 */

import { type ApiResult, apiGetter, type WebsiteApiOptions } from '../websiteApi';

/** The news categories of the API contract, in the order the filters list them. */
export const CATEGORIES = [
  'security',
  'release',
  'deprecation',
  'end-of-life',
  'ai',
  'tooling',
  'industry',
] as const;

/** The severity levels of the API contract, lowest first. */
export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;

export type Category = (typeof CATEGORIES)[number];
export type Severity = (typeof SEVERITIES)[number];

export const isCategory = (value: unknown): value is Category =>
  CATEGORIES.includes(value as Category);

export const isSeverity = (value: unknown): value is Severity =>
  SEVERITIES.includes(value as Severity);

/** A technology a news item names, with the versions it affects. */
export interface AffectedTechnology {
  technology: string;
  name: string;
  versionRange: string;
  /** The first version that is not affected, or null when no fix is out. */
  fixedIn: string | null;
}

/** A `NewsListItemDto` from the API contract. */
export interface NewsListItem {
  id: number;
  slug: string;
  url: string;
  title: string;
  summary: string;
  category: Category;
  severity: Severity;
  technologies: AffectedTechnology[];
  cveIds: string[];
  cvssScore: number | null;
  tags: string[];
  publishedAt: string;
  updatedAt: string;
}

export interface SourceLink {
  title: string;
  url: string;
}

/** A `NewsItemDto`: a list item with its sanitized body and its sources. */
export interface NewsItem extends NewsListItem {
  bodyHtml: string;
  sourceLinks: SourceLink[];
}

/** A `Page<NewsListItemDto>`. */
export interface NewsPage {
  items: NewsListItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/** The slugs the API's `/news/{slug}` route accepts; anything else could never be an item. */
export const NEWS_SLUG = /^[a-z0-9-]*[a-z][a-z0-9-]*$/;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';

const isCount = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

const isTime = (value: unknown): value is string =>
  isString(value) && !Number.isNaN(Date.parse(value));

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isString) : []);

function parseTechnology(value: unknown): AffectedTechnology | null {
  if (!isObject(value)) return null;
  const { technology, name, versionRange, fixedIn } = value;
  if (!isString(technology) || !isString(name) || !isString(versionRange)) return null;
  return { technology, name, versionRange, fixedIn: isString(fixedIn) ? fixedIn : null };
}

function parseSource(value: unknown): SourceLink | null {
  if (!isObject(value) || !isString(value.title) || !isString(value.url)) return null;
  return { title: value.title, url: value.url };
}

/** A NewsListItemDto checked field by field, or null when the page could not show it. */
function parseListItem(value: unknown): NewsListItem | null {
  if (!isObject(value)) return null;
  const { id, slug, url, title, summary, category, severity, technologies, cvssScore } = value;
  const { publishedAt, updatedAt } = value;
  if (
    !isCount(id) ||
    !isString(slug) ||
    !isString(url) ||
    !isString(title) ||
    typeof summary !== 'string' ||
    !isCategory(category) ||
    !isSeverity(severity) ||
    !Array.isArray(technologies) ||
    !isTime(publishedAt) ||
    !isTime(updatedAt)
  ) {
    return null;
  }
  return {
    id,
    slug,
    url,
    title,
    summary,
    category,
    severity,
    technologies: technologies.map(parseTechnology).filter((each) => each !== null),
    cveIds: strings(value.cveIds),
    cvssScore: typeof cvssScore === 'number' ? cvssScore : null,
    tags: strings(value.tags),
    publishedAt,
    updatedAt,
  };
}

/** A NewsItemDto, or null when it lacks a field the item page needs. */
export function parseNewsItem(value: unknown): NewsItem | null {
  const item = parseListItem(value);
  if (!item || !isObject(value) || typeof value.bodyHtml !== 'string') return null;
  const sources = Array.isArray(value.sourceLinks) ? value.sourceLinks : [];
  return {
    ...item,
    bodyHtml: value.bodyHtml,
    sourceLinks: sources.map(parseSource).filter((each) => each !== null),
  };
}

/** A page of list items. Items the page cannot show are dropped; the paging numbers must be there. */
export function parseNewsPage(value: unknown): NewsPage | null {
  if (!isObject(value) || !Array.isArray(value.items)) return null;
  const { page, pageSize, totalItems, totalPages } = value;
  if (!isCount(page) || !isCount(pageSize) || !isCount(totalItems) || !isCount(totalPages)) {
    return null;
  }
  const items = value.items.map(parseListItem).filter((item) => item !== null);
  return { items, page, pageSize, totalItems, totalPages };
}

export interface ListNewsQuery {
  categories?: Category[];
  severities?: Severity[];
  /** Items published at or after this time. */
  since?: Date;
  page?: number;
  pageSize?: number;
}

export interface NewsApi {
  listNews(query: ListNewsQuery): Promise<ApiResult<NewsPage>>;
  getNewsItem(slug: string): Promise<ApiResult<NewsItem>>;
}

export function createNewsApi(
  baseUrl: string | undefined,
  options: WebsiteApiOptions = {},
): NewsApi {
  const get = apiGetter(baseUrl, options);

  return {
    listNews({ categories = [], severities = [], since, page = 1, pageSize = 20 }) {
      const query = new URLSearchParams();
      for (const category of categories) query.append('category', category);
      for (const severity of severities) query.append('severity', severity);
      if (since) query.set('since', since.toISOString());
      query.set('page', String(page));
      query.set('pageSize', String(pageSize));
      return get(`/api/v1/news?${query}`, parseNewsPage);
    },
    getNewsItem(slug) {
      return get(`/api/v1/news/${encodeURIComponent(slug)}`, parseNewsItem);
    },
  };
}

/** The API the pages read, from `WEBSITE_API_INTERNAL_URL` as it is when the request comes in. */
export function newsApi(): NewsApi {
  return createNewsApi(process.env.WEBSITE_API_INTERNAL_URL);
}
