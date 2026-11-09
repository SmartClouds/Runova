import { vi } from 'vitest';

/**
 * Stands in for every package registry at once. Routes are full URLs and the value is the body
 * served. A URL with no route answers 404, and a null body is a dropped connection. Call
 * `vi.unstubAllGlobals()` afterwards.
 */
export function stubRegistry(routes: Record<string, string | null>): string[] {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    requests.push(url);
    if (!Object.hasOwn(routes, url)) return new Response('not found', { status: 404 });
    const body = routes[url];
    if (body === null) throw new TypeError('fetch failed');
    return new Response(body);
  });
  return requests;
}
