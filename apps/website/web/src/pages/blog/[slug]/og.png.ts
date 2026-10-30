import type { APIRoute } from 'astro';
import { blogApi, POST_SLUG } from '../../../lib/blog/api';
import { renderOgImage } from '../../../lib/blog/ogImage';
import { CACHE, RETRY_AFTER_SECONDS } from '../../../lib/blog/page';
import { formatLongDate } from '../../../lib/dates';

// Drawn per request for posts without a cover; the proxy caches it by its Cache-Control.
export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const slug = params.slug ?? '';
  const result = POST_SLUG.test(slug)
    ? await blogApi().getPost(slug)
    : ({ ok: false, reason: 'not-found' } as const);
  if (!result.ok) {
    const unavailable = result.reason === 'unavailable';
    return new Response(null, {
      status: unavailable ? 503 : 404,
      headers: {
        'Cache-Control': CACHE.none,
        ...(unavailable ? { 'Retry-After': String(RETRY_AFTER_SECONDS) } : {}),
      },
    });
  }
  const post = result.value;
  const png = await renderOgImage({
    title: post.title,
    byline: `${post.author.displayName}  ·  ${formatLongDate(post.publishedAt)}`,
  });
  return new Response(new Uint8Array(png), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': CACHE.post },
  });
};
