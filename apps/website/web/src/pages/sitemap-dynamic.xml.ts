import type { APIRoute } from 'astro';
import { blogApi } from '../lib/blog/api';
import { CACHE as BLOG_CACHE, RETRY_AFTER_SECONDS } from '../lib/blog/page';
import { newsApi } from '../lib/news/api';
import { dynamicUrls, SITEMAP_CACHE, urlset } from '../lib/sitemap';

// Rendered per request from the API; the sitemap index lists it next to the static sitemap.
export const prerender = false;

export const GET: APIRoute = async ({ site }) => {
  const result = await dynamicUrls(blogApi(), newsApi());
  if (!result.ok) {
    return new Response('The sitemap could not be loaded. Try again in a minute.', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': BLOG_CACHE.none,
        'Retry-After': String(RETRY_AFTER_SECONDS),
      },
    });
  }
  const xml = urlset(site ?? new URL('https://runovahq.com'), result.value);
  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': SITEMAP_CACHE },
  });
};
