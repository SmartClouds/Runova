import { SITE_NAME } from '../seo';
import type { PostListItem } from './api';

/**
 * The blog as an RSS 2.0 feed, with the Atom namespace for its self link and Dublin Core for the
 * author (RSS's own `author` must be an email address, which posts do not have).
 */

/** How many of the latest posts the feed lists. */
export const FEED_SIZE = 20;

export const FEED_DESCRIPTION = `Posts from the ${SITE_NAME} team on agentic development, Relay and each release of the desktop app.`;

/** Text for an XML element or attribute. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** An RFC 822 date as RSS wants it, such as "Fri, 30 Oct 2026 09:00:00 GMT". */
export function rfc822(date: Date): string {
  return date.toUTCString();
}

const element = (name: string, text: string) => `<${name}>${escapeXml(text)}</${name}>`;

function item(site: string | URL, post: PostListItem): string {
  const link = new URL(`/blog/${post.slug}`, site).href;
  return [
    '<item>',
    element('title', post.title),
    element('link', link),
    `<guid isPermaLink="true">${escapeXml(link)}</guid>`,
    element('description', post.excerpt),
    element('pubDate', rfc822(new Date(post.publishedAt))),
    element('dc:creator', post.author.displayName),
    ...post.tags.map((tag) => element('category', tag.name)),
    '</item>',
  ].join('');
}

/** The feed of `posts` (newest first). Its build date is the newest post's, so it stays stable. */
export function blogFeed(site: string | URL, posts: PostListItem[], now = new Date()): string {
  const blog = new URL('/blog', site).href;
  const self = new URL('/blog/rss.xml', site).href;
  const built = posts[0] ? new Date(posts[0].updatedAt) : now;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '<channel>',
    element('title', `${SITE_NAME} blog`),
    element('link', blog),
    element('description', FEED_DESCRIPTION),
    element('language', 'en'),
    element('lastBuildDate', rfc822(built)),
    `<atom:link href="${escapeXml(self)}" rel="self" type="application/rss+xml"/>`,
    ...posts.map((post) => item(site, post)),
    '</channel>',
    '</rss>',
  ].join('\n');
}
