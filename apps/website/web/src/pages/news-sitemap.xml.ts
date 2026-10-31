import type { APIRoute } from 'astro';
import { CACHE as BLOG_CACHE, RETRY_AFTER_SECONDS } from '../lib/blog/page';
import { newsApi } from '../lib/news/api';
import { CACHE } from '../lib/news/page';
import { newsSitemap, recentNews } from '../lib/news/sitemap';

// Rendered per request from the API; the proxy caches it by its Cache-Control.
export const prerender = false;

export const GET: APIRoute = async ({ site }) => {
  const now = new Date();
  const result = await recentNews(newsApi(), now);
  if (!result.ok) {
    return new Response('The news sitemap could not be loaded. Try again in a minute.', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': BLOG_CACHE.none,
        'Retry-After': String(RETRY_AFTER_SECONDS),
      },
    });
  }
  const xml = newsSitemap(site ?? new URL('https://runovahq.com'), result.value, now);
  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': CACHE.sitemap },
  });
};
