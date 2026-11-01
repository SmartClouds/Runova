/**
 * The newest news items and blog posts the header menu shows. Most pages are prerendered, so the
 * menu reads these from `/nav/latest.json` (src/pages/nav/latest.json.ts) when a visitor reaches
 * for it, and the client script (src/components/header/latest.ts) draws them.
 */

import type { BlogApi, PostListItem } from './blog/api';
import { formatShortDate } from './dates';
import type { Category, NewsApi, NewsListItem } from './news/api';
import { CATEGORY_LABELS } from './news/page';

/** How many of each the menu shows: the newest as a large card, the others as rows. */
export const LATEST_COUNT = 3;

/** The tint of an entry's art. News is tinted by its category; posts take one from their slug. */
export type Tone = Category;

/** One link in the menu, already worded, so the client only has to put it on the page. */
export interface LatestEntry {
  href: string;
  title: string;
  summary: string;
  /** What sits under the title, such as "Security · Oct 30, 2026". */
  meta: string;
  publishedAt: string;
  tone: Tone;
  /** A post's cover. News has none and shows its tint alone. */
  image: string | null;
}

/** The menu's two lists. Null means the API could not be read, which the menu says so. */
export interface Latest {
  news: LatestEntry[] | null;
  blog: LatestEntry[] | null;
}

export function newsEntry(item: NewsListItem): LatestEntry {
  return {
    href: `/news/${item.slug}`,
    title: item.title,
    summary: item.summary,
    meta: `${CATEGORY_LABELS[item.category]} · ${formatShortDate(item.publishedAt)}`,
    publishedAt: item.publishedAt,
    tone: item.category,
    image: null,
  };
}

/** Posts have no category, so these are the tints they rotate through. */
const POST_TONES: Tone[] = ['release', 'ai', 'tooling', 'industry'];

/** The same tint for a slug every time, so a post keeps its look between visits. */
export function postTone(slug: string): Tone {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return POST_TONES[hash % POST_TONES.length] as Tone;
}

export function postEntry(post: PostListItem): LatestEntry {
  return {
    href: `/blog/${post.slug}`,
    title: post.title,
    summary: post.excerpt,
    meta: `${formatShortDate(post.publishedAt)} · ${post.readingTimeMinutes} min read`,
    publishedAt: post.publishedAt,
    tone: postTone(post.slug),
    image: post.coverImage?.url ?? null,
  };
}

/** Both lists, read at the same time. One failing leaves the other in place. */
export async function loadLatest(news: NewsApi, blog: BlogApi): Promise<Latest> {
  const [items, posts] = await Promise.all([
    news.listNews({ page: 1, pageSize: LATEST_COUNT }),
    blog.listPosts({ page: 1, pageSize: LATEST_COUNT }),
  ]);
  return {
    news: items.ok ? items.value.items.slice(0, LATEST_COUNT).map(newsEntry) : null,
    blog: posts.ok ? posts.value.items.slice(0, LATEST_COUNT).map(postEntry) : null,
  };
}
