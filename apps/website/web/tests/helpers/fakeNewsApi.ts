import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FIXTURE_NEWS, type FixtureNewsItem } from '../fixtures/news/items';

export interface FakeNewsApiOptions {
  /** 200 by default; any other status answers every news request with that problem. */
  status?: number;
  /** Published items, newest first. */
  items?: FixtureNewsItem[];
  port?: number;
  host?: string;
}

export interface FakeNewsApi {
  url: string;
  /** The paths and queries it was asked for, in order. */
  requests: string[];
  close: () => Promise<void>;
}

const CATEGORIES = [
  'security',
  'release',
  'deprecation',
  'end-of-life',
  'ai',
  'tooling',
  'industry',
];
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

function problem(reply: ServerResponse, status: number, title: string) {
  reply.writeHead(status, { 'content-type': 'application/problem+json' });
  reply.end(JSON.stringify({ status, title }));
}

function json(reply: ServerResponse, body: unknown, headers: Record<string, string> = {}) {
  reply.writeHead(200, { 'content-type': 'application/json', ...headers });
  reply.end(JSON.stringify(body));
}

/** The list item an item appears as: the item without its body and sources. */
function listItem({ bodyHtml: _, sourceLinks: __, ...rest }: FixtureNewsItem) {
  return rest;
}

/** The items matching the `GET /api/v1/news` filters, or null when a value is not valid (400). */
function filter(items: FixtureNewsItem[], query: URLSearchParams): FixtureNewsItem[] | null {
  const categories = query.getAll('category');
  const severities = query.getAll('severity');
  const minSeverity = query.get('minSeverity');
  const technologies = query.getAll('technology');
  const since = query.get('since');
  const sinceTime = since === null ? null : Date.parse(since);
  if (
    categories.some((value) => !CATEGORIES.includes(value)) ||
    severities.some((value) => !SEVERITIES.includes(value)) ||
    (minSeverity !== null && !SEVERITIES.includes(minSeverity)) ||
    Number.isNaN(sinceTime)
  ) {
    return null;
  }
  return items.filter(
    (item) =>
      (categories.length === 0 || categories.includes(item.category)) &&
      (severities.length === 0 || severities.includes(item.severity)) &&
      (minSeverity === null ||
        SEVERITIES.indexOf(item.severity) >= SEVERITIES.indexOf(minSeverity)) &&
      (technologies.length === 0 ||
        item.technologies.some((each) => technologies.includes(each.technology))) &&
      (sinceTime === null || Date.parse(item.publishedAt) >= sinceTime),
  );
}

/**
 * Answers the anonymous news reads of the API contract (`GET /api/v1/news` and
 * `/api/v1/news/{slug}`) from `items`. Returns false for any other request so a server can try
 * other routes.
 */
export function handleNewsRequest(
  request: IncomingMessage,
  reply: ServerResponse,
  options: Pick<FakeNewsApiOptions, 'status' | 'items'> = {},
): boolean {
  const { status = 200, items = FIXTURE_NEWS } = options;
  const url = new URL(request.url ?? '/', 'http://fake');
  const isList = url.pathname === '/api/v1/news';
  const slug = /^\/api\/v1\/news\/([^/]+)$/.exec(url.pathname)?.[1];
  if (request.method !== 'GET' || !(isList || slug)) return false;

  if (status !== 200) {
    problem(reply, status, 'Unavailable.');
  } else if (isList) {
    const page = Number(url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20);
    const matching = filter(items, url.searchParams);
    if (
      !matching ||
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      problem(reply, 400, 'The request is not valid.');
    } else {
      const sort = url.searchParams.get('sort') ?? '-publishedAt';
      const sorted =
        sort === 'publishedAt'
          ? [...matching].reverse()
          : sort === '-severity'
            ? [...matching].sort(
                (a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity),
              )
            : matching;
      const totalPages = Math.ceil(sorted.length / pageSize);
      json(
        reply,
        {
          items: sorted.slice((page - 1) * pageSize, page * pageSize).map(listItem),
          page,
          pageSize,
          totalItems: sorted.length,
          totalPages,
        },
        { etag: `W/"news-${sorted.length}"` },
      );
    }
  } else if (slug) {
    const found = items.find((item) => item.slug === slug);
    if (found) json(reply, found, { etag: `"${found.id}"` });
    else problem(reply, 404, 'There is no published news item with this slug.');
  }
  return true;
}

/** A stand-in for the website API's news reads, for page tests. */
export async function startFakeNewsApi(options: FakeNewsApiOptions = {}): Promise<FakeNewsApi> {
  const { port = 0, host = '127.0.0.1' } = options;
  const requests: string[] = [];
  const server: Server = createServer((request, reply) => {
    requests.push(request.url ?? '');
    if (!handleNewsRequest(request, reply, options)) problem(reply, 404, 'Not found.');
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
