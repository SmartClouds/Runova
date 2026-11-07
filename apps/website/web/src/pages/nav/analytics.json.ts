import type { APIRoute } from 'astro';
import { NO_TAGS, readSiteAnalytics, tagsOf } from '../../lib/analytics';
import { CACHE } from '../../lib/news/page';

// Rendered per request: every public page reads the tracking tags from here (src/lib/analytics.ts).
export const prerender = false;

export const GET: APIRoute = async () => {
  const result = await readSiteAnalytics(process.env.WEBSITE_API_INTERNAL_URL);
  return new Response(JSON.stringify(result.ok ? tagsOf(result.value) : NO_TAGS), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // A minute, like the API's own answer. A failed read is kept briefly, so the API can recover.
      'Cache-Control': result.ok ? CACHE.list : 'public, max-age=15',
      'X-Robots-Tag': 'noindex',
    },
  });
};
