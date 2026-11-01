import type { APIRoute } from 'astro';
import {
  latestDownloadTarget,
  parseDesktopArch,
  parseDesktopOs,
} from '../../../lib/download/latest';
import { releaseSource } from '../../../lib/download/release';

// Rendered per request: the file comes from the latest release the API knows.
export const prerender = false;

export const GET: APIRoute = async ({ params, url }) => {
  const os = parseDesktopOs(params.os);
  if (!os) {
    return new Response('There is no Runova build for that system.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const arch = parseDesktopArch(url.searchParams.get('arch'));
  const release = await releaseSource.latest(process.env.WEBSITE_API_INTERNAL_URL);
  return new Response(null, {
    status: 302,
    headers: {
      Location: latestDownloadTarget(release, os, arch),
      // Short, so a new release reaches the button within a minute.
      'Cache-Control': 'public, max-age=60',
    },
  });
};
