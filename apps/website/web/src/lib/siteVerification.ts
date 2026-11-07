/**
 * The site verification files of Google Search Console (the HTML file method) and Bing Webmaster
 * Tools (`BingSiteAuth.xml`), from the codes an Admin saves on the Analytics settings page (E59).
 * They are rendered per request, so a new code works without a rebuild.
 */

import { ID_SHAPES, readSiteAnalytics } from './analytics';

/** Short, so a code an Admin just changed is seen soon. */
const FOUND_CACHE = 'public, max-age=300';

const notFound = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** `/<name>.html` when `name` is the Search Console file an Admin saved, else 404. */
export async function googleVerificationFile(
  name: string,
  baseUrl = process.env.WEBSITE_API_INTERNAL_URL,
): Promise<Response> {
  if (!ID_SHAPES.googleVerification.test(name)) return notFound();
  const result = await readSiteAnalytics(baseUrl);
  if (!result.ok || result.value.googleSiteVerification !== name) return notFound();
  return new Response(`google-site-verification: ${name}.html`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': FOUND_CACHE,
      'X-Robots-Tag': 'noindex',
    },
  });
}

/** `/BingSiteAuth.xml` with the code an Admin saved, else 404. */
export async function bingVerificationFile(
  baseUrl = process.env.WEBSITE_API_INTERNAL_URL,
): Promise<Response> {
  const result = await readSiteAnalytics(baseUrl);
  const code = result.ok ? result.value.bingSiteVerification : null;
  if (!code) return notFound();
  // The code is letters and digits only (ID_SHAPES), so it is safe in the XML as it is.
  return new Response(`<?xml version="1.0"?>\n<users>\n\t<user>${code}</user>\n</users>\n`, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': FOUND_CACHE,
      'X-Robots-Tag': 'noindex',
    },
  });
}
