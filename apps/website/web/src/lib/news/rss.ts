import { escapeXml, rfc822 } from '../blog/rss';
import { SITE_NAME } from '../seo';
import type { NewsListItem } from './api';
import { CATEGORY_LABELS, SEVERITY_LABELS } from './page';

/** The news as an RSS 2.0 feed, with the Atom namespace for its self link. */

/** How many of the latest items the feed lists. */
export const FEED_SIZE = 20;

export const FEED_DESCRIPTION =
  'Security advisories, releases and end-of-life dates for the tools developers use, from the Runova team.';

const element = (name: string, text: string) => `<${name}>${escapeXml(text)}</${name}>`;

function item(site: string | URL, news: NewsListItem): string {
  const link = new URL(`/news/${news.slug}`, site).href;
  return [
    '<item>',
    element('title', news.title),
    element('link', link),
    `<guid isPermaLink="true">${escapeXml(link)}</guid>`,
    element('description', news.summary),
    element('pubDate', rfc822(new Date(news.publishedAt))),
    element('category', CATEGORY_LABELS[news.category]),
    // Info is the level of everything that is not security, so only real levels are named.
    ...(news.severity === 'info'
      ? []
      : [element('category', `${SEVERITY_LABELS[news.severity]} severity`)]),
    '</item>',
  ].join('');
}

/** The feed of `items` (newest first). Its build date is the newest item's, so it stays stable. */
export function newsFeed(site: string | URL, items: NewsListItem[], now = new Date()): string {
  const news = new URL('/news', site).href;
  const self = new URL('/news/rss.xml', site).href;
  const built = items[0] ? new Date(items[0].updatedAt) : now;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    element('title', `${SITE_NAME} news`),
    element('link', news),
    element('description', FEED_DESCRIPTION),
    element('language', 'en'),
    element('lastBuildDate', rfc822(built)),
    `<atom:link href="${escapeXml(self)}" rel="self" type="application/rss+xml"/>`,
    ...items.map((each) => item(site, each)),
    '</channel>',
    '</rss>',
  ].join('\n');
}
