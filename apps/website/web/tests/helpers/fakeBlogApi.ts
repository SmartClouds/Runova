import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FIXTURE_POSTS, type FixturePost } from '../fixtures/blog/posts';

export interface FakeBlogApiOptions {
  /** 200 by default; any other status answers every blog request with that problem. */
  status?: number;
  /** Published posts, newest first. */
  posts?: FixturePost[];
  port?: number;
  host?: string;
}

export interface FakeBlogApi {
  url: string;
  /** The paths and queries it was asked for, in order. */
  requests: string[];
  close: () => Promise<void>;
}

function problem(reply: ServerResponse, status: number, title: string) {
  reply.writeHead(status, { 'content-type': 'application/problem+json' });
  reply.end(JSON.stringify({ status, title }));
}

function json(reply: ServerResponse, body: unknown, headers: Record<string, string> = {}) {
  reply.writeHead(200, { 'content-type': 'application/json', ...headers });
  reply.end(JSON.stringify(body));
}

/** The list item a post appears as: the post without its body. */
function listItem({ bodyHtml: _, ...item }: FixturePost) {
  return item;
}

/** The `Link` header from the paging rules: first, prev, next and last where they exist. */
function pageLinks(path: string, query: URLSearchParams, page: number, totalPages: number) {
  const link = (n: number, rel: string) => {
    const next = new URLSearchParams(query);
    next.set('page', String(n));
    return `<${path}?${next}>; rel="${rel}"`;
  };
  const links = [link(1, 'first')];
  if (page > 1) links.push(link(Math.min(page - 1, Math.max(totalPages, 1)), 'prev'));
  if (page < totalPages) links.push(link(page + 1, 'next'));
  if (totalPages > 0) links.push(link(totalPages, 'last'));
  return links.join(', ');
}

/**
 * Answers the anonymous blog reads of the API contract (`GET /api/v1/posts`, `/posts/{slug}` and
 * `/tags`) from `posts`. Returns false for any other request so a server can try other routes.
 */
export function handleBlogRequest(
  request: IncomingMessage,
  reply: ServerResponse,
  options: Pick<FakeBlogApiOptions, 'status' | 'posts'> = {},
): boolean {
  const { status = 200, posts = FIXTURE_POSTS } = options;
  const url = new URL(request.url ?? '/', 'http://fake');
  const isList = url.pathname === '/api/v1/posts';
  const slug = /^\/api\/v1\/posts\/([^/]+)$/.exec(url.pathname)?.[1];
  const isTags = url.pathname === '/api/v1/tags';
  if (request.method !== 'GET' || !(isList || slug || isTags)) return false;

  if (status !== 200) {
    problem(reply, status, 'Unavailable.');
  } else if (isList) {
    const page = Number(url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize)) {
      problem(reply, 400, 'The request is not valid.');
    } else if (pageSize < 1 || pageSize > 100) {
      problem(reply, 400, 'The request is not valid.');
    } else {
      const tags = url.searchParams.getAll('tag');
      const matching = posts.filter(
        (post) => tags.length === 0 || post.tags.some((tag) => tags.includes(tag.slug)),
      );
      const totalPages = Math.ceil(matching.length / pageSize);
      const items = matching.slice((page - 1) * pageSize, page * pageSize).map(listItem);
      json(
        reply,
        { items, page, pageSize, totalItems: matching.length, totalPages },
        {
          etag: `W/"posts-${matching.length}"`,
          link: pageLinks(url.pathname, url.searchParams, page, totalPages),
        },
      );
    }
  } else if (slug) {
    const found = posts.find((post) => post.slug === slug);
    if (found) json(reply, found, { etag: `"${found.id}"` });
    else problem(reply, 404, 'There is no published post with this slug.');
  } else {
    const counts = new Map<string, { slug: string; name: string; postCount: number }>();
    for (const tag of posts.flatMap((post) => post.tags)) {
      const entry = counts.get(tag.slug) ?? { ...tag, postCount: 0 };
      entry.postCount += 1;
      counts.set(tag.slug, entry);
    }
    json(
      reply,
      [...counts.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    );
  }
  return true;
}

/** A stand-in for the website API's blog reads, for page tests. */
export async function startFakeBlogApi(options: FakeBlogApiOptions = {}): Promise<FakeBlogApi> {
  const { port = 0, host = '127.0.0.1' } = options;
  const requests: string[] = [];
  const server: Server = createServer((request, reply) => {
    requests.push(request.url ?? '');
    if (!handleBlogRequest(request, reply, options)) problem(reply, 404, 'Not found.');
  });
  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
