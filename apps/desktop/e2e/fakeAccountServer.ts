import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMemorySyncServer } from '../src/main/sync/testing/memoryServer';

/**
 * The website API's account and sync routes for the desktop e2e tests (E48), on loopback. One
 * account, signed in by every app that asks: `/account/authorize` approves at once and sends the
 * browser back to the app's listener with a code, as a person pressing "Sign in this computer"
 * would. Sync records go through the same revision rules the engine's unit tests use, so a test
 * can read exactly what the server would hold.
 */

export const ACCOUNT = {
  id: 42,
  email: 'sam@example.test',
  displayName: 'Sam Rivera',
  emailConfirmed: true,
  hasPassword: true,
  twoFactorEnabled: true,
  logins: [],
  staff: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  lastSignInAt: null,
  version: '1',
};

interface Session {
  id: number;
  deviceName: string;
  platform: string;
  refreshToken: string;
  accessToken: string;
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf-8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function json(response: ServerResponse, status: number, value?: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(value === undefined ? '' : JSON.stringify(value));
}

export async function startFakeAccountServer() {
  const sync = createMemorySyncServer([{ id: 1, name: 'Personal' }]);
  const api = sync.client();
  const codes = new Map<
    string,
    { challenge: string; redirectUri: string; deviceName: string; platform: string }
  >();
  const sessions: Session[] = [];
  const keys = new Map<number, { version: number; envelope: unknown; setAt: string }>();

  const sessionFor = (request: IncomingMessage) => {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    return sessions.find((s) => s.accessToken === token) ?? null;
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const method = request.method ?? 'GET';

      if (method === 'GET' && path === '/account/authorize') {
        const code = base64url(randomBytes(16));
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        codes.set(code, {
          challenge: url.searchParams.get('code_challenge') ?? '',
          redirectUri,
          deviceName: url.searchParams.get('device_name') ?? 'Computer',
          platform: url.searchParams.get('platform') ?? 'windows',
        });
        response.writeHead(302, {
          location: `${redirectUri}?code=${code}&state=${url.searchParams.get('state')}`,
        });
        response.end();
        return;
      }

      if (method === 'POST' && path === '/api/v1/device-tokens') {
        const input = await body(request);
        if (input.grantType === 'authorization_code') {
          const approval = codes.get(String(input.code));
          codes.delete(String(input.code));
          const challenge = base64url(
            createHash('sha256').update(String(input.codeVerifier)).digest(),
          );
          if (
            !approval ||
            approval.challenge !== challenge ||
            approval.redirectUri !== input.redirectUri
          ) {
            json(response, 401, {
              type: 'https://runovahq.com/problems/unauthorized',
              status: 401,
              detail: 'No.',
            });
            return;
          }
          const session: Session = {
            id: sessions.length + 1,
            deviceName: approval.deviceName,
            platform: approval.platform,
            refreshToken: `rr1.${base64url(randomBytes(16))}`,
            accessToken: `rd1.${base64url(randomBytes(16))}`,
          };
          sessions.push(session);
          json(response, 200, {
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
            expiresIn: 900,
            sessionId: session.id,
            account: ACCOUNT,
          });
          return;
        }
        const session = sessions.find((s) => s.refreshToken === input.refreshToken);
        if (!session) {
          json(response, 401, {
            type: 'https://runovahq.com/problems/unauthorized',
            status: 401,
            detail: 'Sign in again.',
          });
          return;
        }
        session.refreshToken = `rr1.${base64url(randomBytes(16))}`;
        session.accessToken = `rd1.${base64url(randomBytes(16))}`;
        json(response, 200, {
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          expiresIn: 900,
          sessionId: session.id,
          account: ACCOUNT,
        });
        return;
      }

      const session = sessionFor(request);
      if (!session) {
        json(response, 401, {
          type: 'https://runovahq.com/problems/unauthorized',
          status: 401,
          detail: 'Sign in again.',
        });
        return;
      }

      const scopeMatch = /^\/api\/v1\/sync-scopes\/(\d+)(\/.*)?$/.exec(path);
      try {
        if (method === 'GET' && path === '/api/v1/accounts/me') return json(response, 200, ACCOUNT);
        if (method === 'GET' && path === '/api/v1/sessions') {
          return json(response, 200, {
            items: sessions.map((s) => ({
              id: s.id,
              kind: 'desktop',
              deviceName: s.deviceName,
              platform: s.platform,
              appVersion: '9.9.9',
              ip: '127.0.0.1',
              createdAt: '2026-11-05T10:00:00.000Z',
              lastSeenAt: '2026-11-05T10:00:00.000Z',
              current: s.id === session.id,
            })),
          });
        }
        if (method === 'DELETE' && path === '/api/v1/sessions/current') {
          sessions.splice(sessions.indexOf(session), 1);
          return json(response, 204);
        }
        if (method === 'GET' && path === '/api/v1/activities') {
          return json(response, 200, {
            items: [],
            page: 1,
            pageSize: 50,
            totalItems: 0,
            totalPages: 0,
          });
        }
        if (method === 'GET' && path === '/api/v1/teams') return json(response, 200, { items: [] });
        if (method === 'GET' && path === '/api/v1/invitations')
          return json(response, 200, { items: [] });
        if (method === 'GET' && path === '/api/v1/sync-scopes') {
          return json(response, 200, {
            items: (await api.scopes()).map((s) => ({
              ...s,
              keyVersion: keys.get(s.id)?.version ?? null,
            })),
          });
        }
        if (scopeMatch) {
          const scopeId = Number(scopeMatch[1]);
          const rest = scopeMatch[2] ?? '';
          if (method === 'GET' && rest === '/changes') {
            return json(
              response,
              200,
              await api.changes(
                scopeId,
                Number(url.searchParams.get('since') ?? 0),
                Number(url.searchParams.get('limit') ?? 500),
              ),
            );
          }
          if (method === 'POST' && rest === '/records') {
            return json(
              response,
              200,
              await api.push(scopeId, (await body(request)).records as never),
            );
          }
          if (method === 'GET' && rest === '/usage') {
            return json(response, 200, {
              records: sync.all(scopeId).length,
              bytes: 0,
              quotaBytes: 1,
              collections: {},
            });
          }
          if (rest === '/keys/current') {
            if (method === 'GET') {
              const key = keys.get(scopeId);
              return key
                ? json(response, 200, key)
                : json(response, 404, {
                    type: 'https://runovahq.com/problems/not-found',
                    status: 404,
                    detail: 'No key yet.',
                  });
            }
            if (method === 'PUT') {
              const input = await body(request);
              keys.set(scopeId, {
                version: Number(input.version),
                envelope: input.envelope,
                setAt: new Date().toISOString(),
              });
              sync.setScope(scopeId, { keyVersion: Number(input.version) });
              return json(response, 200, keys.get(scopeId));
            }
          }
          if (method === 'PATCH' && rest === '') {
            const input = await body(request);
            sync.setScope(scopeId, { policy: input.policy as never });
            return json(response, 200, sync.scope(scopeId));
          }
        }
        json(response, 404, {
          type: 'https://runovahq.com/problems/not-found',
          status: 404,
          detail: `No route ${method} ${path}`,
        });
      } catch (error) {
        json(response, 500, {
          type: 'https://runovahq.com/problems/internal',
          status: 500,
          detail: String(error),
        });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/api/v1`,
    /** What the server holds, exactly as the apps pushed it. */
    records: (scopeId = 1) => sync.all(scopeId),
    sessions: () => sessions,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeAccountServer = Awaited<ReturnType<typeof startFakeAccountServer>>;
