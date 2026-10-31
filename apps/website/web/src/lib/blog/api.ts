/**
 * The blog reads of the website API (`GET /api/v1/posts` and `/api/v1/posts/{slug}`, T009). Nothing
 * is cached here: the pages send Cache-Control and the proxy in front of the site caches by it.
 */

import { type ApiResult, apiGetter, type WebsiteApiOptions } from '../websiteApi';

export interface PostTag {
  slug: string;
  name: string;
}

export interface CoverImage {
  url: string;
  width: number;
  height: number;
  alt: string;
}

/** A `PostListItemDto` from the API contract. */
export interface PostListItem {
  id: number;
  slug: string;
  url: string;
  title: string;
  excerpt: string;
  coverImage: CoverImage | null;
  tags: PostTag[];
  author: { displayName: string };
  publishedAt: string;
  updatedAt: string;
  readingTimeMinutes: number;
}

/** A `PostDto`: a list item with its sanitized body. */
export interface Post extends PostListItem {
  bodyHtml: string;
}

/** A `Page<PostListItemDto>`. */
export interface PostPage {
  items: PostListItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/** The slugs the API's `/posts/{slug}` route accepts; anything else could never be a post. */
export const POST_SLUG = /^[a-z0-9-]*[a-z][a-z0-9-]*$/;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';

const isCount = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

const isTime = (value: unknown): value is string =>
  isString(value) && !Number.isNaN(Date.parse(value));

function parseTag(value: unknown): PostTag | null {
  if (!isObject(value) || !isString(value.slug) || !isString(value.name)) return null;
  return { slug: value.slug, name: value.name };
}

function parseCover(value: unknown): CoverImage | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const { url, width, height, alt } = value;
  if (!isString(url) || !isCount(width) || !isCount(height) || typeof alt !== 'string') {
    return undefined;
  }
  return { url, width, height, alt };
}

/** A PostListItemDto checked field by field, or null when the page could not show it. */
function parseListItem(value: unknown): PostListItem | null {
  if (!isObject(value)) return null;
  const {
    id,
    slug,
    url,
    title,
    excerpt,
    tags,
    author,
    publishedAt,
    updatedAt,
    readingTimeMinutes,
  } = value;
  const coverImage = parseCover(value.coverImage);
  if (
    !isCount(id) ||
    !isString(slug) ||
    !isString(url) ||
    !isString(title) ||
    typeof excerpt !== 'string' ||
    coverImage === undefined ||
    !Array.isArray(tags) ||
    !isObject(author) ||
    !isString(author.displayName) ||
    !isTime(publishedAt) ||
    !isTime(updatedAt) ||
    !isCount(readingTimeMinutes)
  ) {
    return null;
  }
  return {
    id,
    slug,
    url,
    title,
    excerpt,
    coverImage,
    tags: tags.map(parseTag).filter((tag) => tag !== null),
    author: { displayName: author.displayName },
    publishedAt,
    updatedAt,
    readingTimeMinutes,
  };
}

/** A PostDto, or null when it lacks a field the post page needs. */
export function parsePost(value: unknown): Post | null {
  const item = parseListItem(value);
  if (!item || !isObject(value) || !isString(value.bodyHtml)) return null;
  return { ...item, bodyHtml: value.bodyHtml };
}

/** A page of list items. Items the page cannot show are dropped; the paging numbers must be there. */
export function parsePostPage(value: unknown): PostPage | null {
  if (!isObject(value) || !Array.isArray(value.items)) return null;
  const { page, pageSize, totalItems, totalPages } = value;
  if (!isCount(page) || !isCount(pageSize) || !isCount(totalItems) || !isCount(totalPages)) {
    return null;
  }
  const items = value.items.map(parseListItem).filter((item) => item !== null);
  return { items, page, pageSize, totalItems, totalPages };
}

/** A tag with the number of published posts that carry it (`GET /api/v1/tags`). */
export interface TagCount extends PostTag {
  postCount: number;
}

/** The tag list. Entries that lack a field are dropped. */
export function parseTags(value: unknown): TagCount[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const tag = parseTag(entry);
    return tag && isObject(entry) && isCount(entry.postCount)
      ? [{ ...tag, postCount: entry.postCount }]
      : [];
  });
}

export interface ListPostsQuery {
  page?: number;
  pageSize?: number;
  /** Posts with any of these tag slugs. */
  tags?: string[];
}

export interface BlogApi {
  listPosts(query: ListPostsQuery): Promise<ApiResult<PostPage>>;
  getPost(slug: string): Promise<ApiResult<Post>>;
  listTags(): Promise<ApiResult<TagCount[]>>;
}

export function createBlogApi(
  baseUrl: string | undefined,
  options: WebsiteApiOptions = {},
): BlogApi {
  const get = apiGetter(baseUrl, options);

  return {
    listPosts({ page = 1, pageSize = 10, tags = [] }) {
      const query = new URLSearchParams();
      for (const tag of tags) query.append('tag', tag);
      query.set('page', String(page));
      query.set('pageSize', String(pageSize));
      return get(`/api/v1/posts?${query}`, parsePostPage);
    },
    getPost(slug) {
      return get(`/api/v1/posts/${encodeURIComponent(slug)}`, parsePost);
    },
    listTags() {
      return get('/api/v1/tags', parseTags);
    },
  };
}

/** The API the pages read, from `WEBSITE_API_INTERNAL_URL` as it is when the request comes in. */
export function blogApi(): BlogApi {
  return createBlogApi(process.env.WEBSITE_API_INTERNAL_URL);
}
