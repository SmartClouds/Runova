import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The ReleaseDto the fake API serves unless told otherwise (v2.2.0's desktop assets). */
export const FAKE_RELEASE = JSON.parse(
  readFileSync(new URL('../fixtures/releases/latest.json', import.meta.url), 'utf8'),
);

export interface FakeReleaseApiOptions {
  /** 200 by default; 503 is what the real API sends before it has fetched a release. */
  status?: number;
  body?: unknown;
  port?: number;
  host?: string;
}

export interface FakeReleaseApi {
  url: string;
  /** The paths it was asked for, in order. */
  requests: string[];
  close: () => Promise<void>;
}

/** A stand-in for the website API's `GET /api/v1/releases/latest`, for page and e2e tests. */
export async function startFakeReleaseApi(
  options: FakeReleaseApiOptions = {},
): Promise<FakeReleaseApi> {
  const { status = 200, body = FAKE_RELEASE, port = 0, host = '127.0.0.1' } = options;
  const requests: string[] = [];
  const server: Server = createServer((request, reply) => {
    requests.push(request.url ?? '');
    if (request.method !== 'GET' || request.url !== '/api/v1/releases/latest') {
      reply.writeHead(404, { 'content-type': 'application/problem+json' });
      reply.end(JSON.stringify({ status: 404, title: 'Not found.' }));
      return;
    }
    if (status !== 200) {
      reply.writeHead(status, { 'content-type': 'application/problem+json' });
      reply.end(JSON.stringify({ status, title: 'Unavailable.' }));
      return;
    }
    reply.writeHead(200, { 'content-type': 'application/json', etag: '"fake-release"' });
    reply.end(JSON.stringify(body));
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

/** A URL where nothing listens, for the API being down. */
export async function deadApiUrl(): Promise<string> {
  const api = await startFakeReleaseApi();
  await api.close();
  return api.url;
}
