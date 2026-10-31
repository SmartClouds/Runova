import type { APIRoute } from 'astro';
import { blogApi } from '../../lib/blog/api';
import { CACHE, RETRY_AFTER_SECONDS } from '../../lib/blog/page';
import { blogFeed, FEED_SIZE } from '../../lib/blog/rss';

// Rendered per request from the API; the proxy caches it by its Cache-Control.
export const prerender = false;

export const GET: APIRoute = async ({ site }) => {
  const result = await blogApi().listPosts({ pageSize: FEED_SIZE });
  if (!result.ok) {
    return new Response('The blog feed could not be loaded. Try again in a minute.', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': CACHE.none,
        'Retry-After': String(RETRY_AFTER_SECONDS),
      },
    });
  }
  const xml = blogFeed(site ?? new URL('https://runovahq.com'), result.value.items);
  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': CACHE.feed },
  });
};
