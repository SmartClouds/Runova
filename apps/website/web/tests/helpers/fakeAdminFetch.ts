import { vi } from 'vitest';

/** A request the code under test made, with its body read as text (or the FormData itself). */
export interface SeenRequest {
  method: string;
  path: string;
  headers: Headers;
  body: string | FormData | null;
  json: () => unknown;
}

type Reply = Response | ((request: SeenRequest) => Response | Promise<Response>);

export function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

export function problem(
  status: number,
  slug: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `https://runovahq.com/problems/${slug}`,
      title: 'The request is not valid.',
      status,
      detail: 'One or more fields are not valid.',
      ...extra,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/**
 * Replaces the global fetch with routes keyed by `METHOD /path` (the query is part of the path).
 * A route holds one reply, or a list answered in turn with the last one repeated. Unknown routes
 * answer 404 and fail the test that expects otherwise.
 */
export function fakeFetch(routes: Record<string, Reply | Reply[]>) {
  const seen: SeenRequest[] = [];
  const counts = new Map<string, number>();

  const fetchFn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'https://runovahq.com');
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body instanceof FormData ? init.body : ((init.body as string) ?? null);
    const request: SeenRequest = {
      method,
      path: `${url.pathname}${url.search}`,
      headers: new Headers(init.headers),
      body,
      json: () => JSON.parse(String(body)),
    };
    seen.push(request);

    const key = `${method} ${request.path}`;
    const route = routes[key];
    if (!route) return new Response(null, { status: 404 });
    const replies = Array.isArray(route) ? route : [route];
    const index = counts.get(key) ?? 0;
    counts.set(key, index + 1);
    const reply = replies[Math.min(index, replies.length - 1)];
    const response = typeof reply === 'function' ? await reply(request) : reply;
    return response.clone();
  });

  vi.stubGlobal('fetch', fetchFn);
  return {
    seen,
    fetch: fetchFn,
    /** The requests to `METHOD /path`, in order. */
    calls: (key: string) => seen.filter((each) => `${each.method} ${each.path}` === key),
  };
}
