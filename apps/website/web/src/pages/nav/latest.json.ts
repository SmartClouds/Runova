import type { APIRoute } from 'astro';
import { blogApi } from '../../lib/blog/api';
import { loadLatest } from '../../lib/latest';
import { newsApi } from '../../lib/news/api';
import { CACHE } from '../../lib/news/page';

// Rendered per request: the header menu on every page reads the newest news and posts from here.
export const prerender = false;

export const GET: APIRoute = async () => {
  const latest = await loadLatest(newsApi(), blogApi());
  const complete = latest.news !== null && latest.blog !== null;
  return new Response(JSON.stringify(latest), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // The same minute as the news list. A failed read is kept briefly, so the API can recover.
      'Cache-Control': complete ? CACHE.list : 'public, max-age=15',
      'X-Robots-Tag': 'noindex',
    },
  });
};
