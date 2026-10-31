import type { APIRoute } from 'astro';
import { robotsTxt } from '../lib/robots';

export const GET: APIRoute = ({ site }) =>
  new Response(robotsTxt(site ?? new URL('https://runovahq.com')), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
