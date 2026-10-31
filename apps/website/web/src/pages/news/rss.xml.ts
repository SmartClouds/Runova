import type { APIRoute } from 'astro';
import { CACHE as BLOG_CACHE, RETRY_AFTER_SECONDS } from '../../lib/blog/page';
import { newsApi } from '../../lib/news/api';
import { CACHE } from '../../lib/news/page';
import { FEED_SIZE, newsFeed } from '../../lib/news/rss';

// Rendered per request from the API; the proxy caches it by its Cache-Control.
export const prerender = false;

export const GET: APIRoute = async ({ site }) => {
  const result = await newsApi().listNews({ pageSize: FEED_SIZE });
  if (!result.ok) {
    return new Response('The news feed could not be loaded. Try again in a minute.', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': BLOG_CACHE.none,
        'Retry-After': String(RETRY_AFTER_SECONDS),
      },
    });
  }
  const xml = newsFeed(site ?? new URL('https://runovahq.com'), result.value.items);
  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': CACHE.feed },
  });
};
