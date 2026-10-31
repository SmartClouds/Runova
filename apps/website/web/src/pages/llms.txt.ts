import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import { llmsTxt } from '../lib/llms';

export const GET: APIRoute = async ({ site }) => {
  const features = (await getCollection('features'))
    .sort((a, b) => a.data.order - b.data.order)
    .map((entry) => ({ slug: entry.id, ...entry.data }));
  return new Response(llmsTxt(site ?? new URL('https://runovahq.com'), features), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
