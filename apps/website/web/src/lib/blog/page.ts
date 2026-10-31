import type { BlogPosting } from 'schema-dts';
import { fitMetaDescription, headline, organizationId, SITE_NAME } from '../seo';
import type { BlogApi, Post, PostListItem, PostPage } from './api';
import { OG_HEIGHT, OG_WIDTH } from './ogImage';

/** Posts per list page. */
export const PAGE_SIZE = 10;

/** The Cache-Control of each blog route, from docs/epics/40-website.md. */
export const CACHE = {
  list: 'public, max-age=60, stale-while-revalidate=300',
  post: 'public, max-age=300, stale-while-revalidate=600',
  feed: 'public, max-age=600, stale-while-revalidate=600',
  /** Not-found and unavailable answers are never cached. */
  none: 'no-store',
} as const;

/** How long a visitor or a crawler waits before asking again when the API is down. */
export const RETRY_AFTER_SECONDS = 60;

/** The tag slugs a page can ask about; anything else is answered with 404 without the API. */
export const TAG_SLUG = /^[a-z0-9-]+$/;

export type PageState = 'ok' | 'not-found' | 'unavailable';

/** Sets the status and headers of a blog answer. `cache` is used only when it is ok. */
export function applyState(
  response: ResponseInit & { headers: Headers },
  state: PageState,
  cache: string,
) {
  if (state === 'ok') {
    response.headers.set('Cache-Control', cache);
    return;
  }
  response.status = state === 'not-found' ? 404 : 503;
  response.headers.set('Cache-Control', CACHE.none);
  if (state === 'unavailable') response.headers.set('Retry-After', String(RETRY_AFTER_SECONDS));
}

/**
 * A page number from the path: 1 or more, written without leading zeros. Anything else is null,
 * which the page answers with 404.
 */
export function parsePageNumber(value: string | undefined): number | null {
  return value && /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

/** The path of page `page` of the list at `base` (`/blog` or `/blog/tags/<tag>`). */
export function pagePath(base: string, page: number): string {
  return page === 1 ? base : `${base}/page/${page}`;
}

const LIST_DESCRIPTION = `Posts from the ${SITE_NAME} team on agentic development, how Relay and the agents work, and what changed in each release of the desktop app.`;

export type ListResult =
  | { state: 'ok'; base: string; page: PostPage; tagName?: string }
  | { state: 'not-found' | 'unavailable' }
  | { state: 'redirect'; location: string };

/**
 * One page of `/blog` or of a tag. `page` is the path parameter, undefined on the first page. Page 1
 * written out redirects to the list itself; a page past the end, or a tag no post has, is not found.
 */
export async function loadList(
  api: BlogApi,
  params: { tag?: string; page?: string },
): Promise<ListResult> {
  const { tag } = params;
  const base = tag === undefined ? '/blog' : `/blog/tags/${tag}`;
  const page = params.page === undefined ? 1 : parsePageNumber(params.page);
  if (page === null || (tag !== undefined && !TAG_SLUG.test(tag))) return { state: 'not-found' };
  if (params.page !== undefined && page === 1) return { state: 'redirect', location: base };

  const result = await api.listPosts({ page, pageSize: PAGE_SIZE, tags: tag ? [tag] : [] });
  if (!result.ok) return { state: result.reason };
  const { totalPages, items } = result.value;
  // An empty blog still shows its first page; an empty tag does not exist.
  if (page > Math.max(totalPages, tag ? 0 : 1)) return { state: 'not-found' };
  const tagName = tag && items.flatMap((item) => item.tags).find((each) => each.slug === tag)?.name;
  return { state: 'ok', base, page: result.value, ...(tag ? { tagName: tagName || tag } : {}) };
}

/** The title and meta description of a list page, unique per tag and page. */
export function listMeta(page: number, totalPages: number, tagName?: string) {
  const name = tagName ? `Posts tagged ${tagName}` : 'Blog';
  const paged = page > 1 ? ` Page ${page} of ${totalPages}.` : '';
  const base = tagName
    ? fitMetaDescription(
        `Posts tagged ${tagName} on the ${SITE_NAME} blog, newest first.`,
        'Written by the team that builds the Agentic Development Environment.',
      )
    : LIST_DESCRIPTION;
  return {
    heading: name,
    title: page > 1 ? `${name}, page ${page}` : name,
    description: `${base}${paged}`,
  };
}

/** The image a post is shared with: its cover, else the title card made for it. */
export function postImage(post: PostListItem) {
  if (post.coverImage) {
    const { url, width, height, alt } = post.coverImage;
    return { src: url, width, height, alt };
  }
  return { src: `/blog/${post.slug}/og.png`, width: OG_WIDTH, height: OG_HEIGHT, alt: post.title };
}

/** The BlogPosting node of a post page, published by the site's Organization. */
export function blogPosting(site: string | URL, post: Post, imageUrl: string): BlogPosting {
  const url = new URL(`/blog/${post.slug}`, site).href;
  return {
    '@type': 'BlogPosting',
    '@id': `${url}#article`,
    headline: headline(post.title),
    description: post.excerpt,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt,
    author: { '@type': 'Person', name: post.author.displayName },
    image: [new URL(imageUrl, site).href],
    url,
    mainEntityOfPage: url,
    ...(post.tags.length > 0 ? { keywords: post.tags.map((tag) => tag.name).join(', ') } : {}),
    inLanguage: 'en',
    publisher: { '@id': organizationId(site) },
    isPartOf: { '@id': new URL('/#website', site).href },
  };
}

/**
 * Up to `count` other posts for the end of a post: those sharing a tag first, then the latest.
 * A failed request leaves the list short or empty, so the post still renders.
 */
export async function relatedPosts(api: BlogApi, post: Post, count = 3): Promise<PostListItem[]> {
  const picked: PostListItem[] = [];
  const add = (items: PostListItem[]) => {
    for (const item of items) {
      if (picked.length === count) return;
      if (item.slug !== post.slug && !picked.some((other) => other.slug === item.slug)) {
        picked.push(item);
      }
    }
  };
  if (post.tags.length > 0) {
    const tagged = await api.listPosts({
      tags: post.tags.map((tag) => tag.slug),
      pageSize: count + 1,
    });
    if (!tagged.ok) return [];
    add(tagged.value.items);
  }
  if (picked.length < count) {
    const latest = await api.listPosts({ pageSize: count + 1 });
    if (latest.ok) add(latest.value.items);
  }
  return picked;
}
