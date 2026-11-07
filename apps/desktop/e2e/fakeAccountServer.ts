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
  // Dependency alerts (E51): what the app sent, and what a test says the daily check found.
  const inventories = new Map<
    string,
    { scopeId: number; itemId: string; body: Record<string, unknown> }
  >();
  let alertSettings: Record<string, unknown> = {
    enabled: true,
    securityMinSeverity: 'high',
    deprecated: true,
    major: true,
    minor: false,
    patch: false,
    inApp: true,
    telegram: true,
  };
  let findings: { items: unknown[] } = { items: [] };
  let notifications: unknown[] = [];
  const muted = new Set<number>();
  // Online monitors (E56): what the app turned online, with the status a test gives them.
  type CloudMonitor = Record<string, unknown> & { id: number; itemId: string; secret?: string };
  const cloudMonitors = new Map<number, CloudMonitor>();
  const cloudCalls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  let nextCloudId = 41;
  const emptyStatus = {
    verdict: 'unknown',
    state: null,
    lastCheckedAt: null,
    latencyMs: null,
    httpStatus: null,
    problem: null,
    region: null,
    confirming: false,
    openIncident: null,
    uptime24h: null,
  };
  /** The monitor as the API answers it: never with its key. */
  const cloudDto = ({ secret: _secret, ...monitor }: CloudMonitor) => monitor;

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
        const inventoryMatch = /^\/api\/v1\/sync-scopes\/(\d+)\/package-inventories\/([^/]+)$/.exec(
          path,
        );
        if (inventoryMatch) {
          const key = `${inventoryMatch[1]}:${decodeURIComponent(inventoryMatch[2])}`;
          if (method === 'PUT') {
            inventories.set(key, {
              scopeId: Number(inventoryMatch[1]),
              itemId: decodeURIComponent(inventoryMatch[2]),
              body: await body(request),
            });
            return json(response, 201, { id: 7 });
          }
          inventories.delete(key);
          return json(response, 204);
        }
        if (method === 'GET' && path === '/api/v1/dependency-findings') {
          const enabled = alertSettings.enabled === true;
          const items = enabled
            ? (findings.items as { inventoryId: number; total: number }[]).map((item) =>
                muted.has(item.inventoryId)
                  ? { ...item, muted: true, total: 0 }
                  : { ...item, muted: false },
              )
            : [];
          return json(response, 200, {
            enabled,
            total: items.reduce((sum, i) => sum + i.total, 0),
            items,
          });
        }
        if (method === 'GET' && path === '/api/v1/notifications') {
          return json(response, 200, {
            items: notifications,
            page: 1,
            pageSize: 50,
            totalItems: notifications.length,
            totalPages: 1,
            unread: notifications.length,
          });
        }
        if (path === '/api/v1/accounts/me/dependency-alert-settings') {
          if (method === 'PATCH') alertSettings = { ...alertSettings, ...(await body(request)) };
          return json(response, 200, alertSettings);
        }
        const muteMatch = /^\/api\/v1\/accounts\/me\/muted-projects\/(\d+)$/.exec(path);
        if (muteMatch) {
          if (method === 'PUT') muted.add(Number(muteMatch[1]));
          else muted.delete(Number(muteMatch[1]));
          return json(response, 204);
        }
        if (path.startsWith('/api/v1/cloud-monitors')) {
          const sentBody =
            method === 'POST' || method === 'PATCH' || method === 'PUT'
              ? await body(request)
              : null;
          cloudCalls.push({ method, path, body: sentBody });
          if (method === 'GET' && path === '/api/v1/cloud-monitors') {
            return json(response, 200, { items: [...cloudMonitors.values()].map(cloudDto) });
          }
          if (method === 'GET' && path === '/api/v1/cloud-monitors/usage') {
            const all = [...cloudMonitors.values()];
            return json(response, 200, {
              scopes: [
                {
                  scopeId: 1,
                  kind: 'personal',
                  name: 'Personal',
                  canWrite: true,
                  accountTypeKey: 'go',
                  accountTypeName: 'Go',
                  maxMonitors: 10,
                  minIntervalSec: 300,
                  historyDays: 30,
                  active: all.filter((m) => !m.paused).length,
                  paused: all.filter((m) => m.paused).length,
                },
              ],
            });
          }
          if (method === 'POST' && path === '/api/v1/cloud-monitors') {
            const input = sentBody ?? {};
            const made: CloudMonitor = {
              ...input,
              id: nextCloudId++,
              itemId: String(input.itemId),
              secret: String(input.secret ?? ''),
              hasSecret: Boolean(input.secret),
              suspendedReason: null,
              muted: false,
              canWrite: true,
              status: emptyStatus,
              version: '1',
            };
            cloudMonitors.set(made.id, made);
            return json(response, 201, cloudDto(made));
          }
          const one = /^\/api\/v1\/cloud-monitors\/(\d+)(\/.*)?$/.exec(path);
          const monitor = one ? cloudMonitors.get(Number(one[1])) : undefined;
          if (!one || !monitor) {
            return json(response, 404, {
              type: 'https://runovahq.com/problems/not-found',
              status: 404,
              detail: 'There is no such online monitor for this account.',
            });
          }
          const rest = one[2] ?? '';
          if (method === 'PATCH' && rest === '') {
            Object.assign(monitor, sentBody ?? {});
            monitor.version = String(Number(monitor.version) + 1);
            return json(response, 200, cloudDto(monitor));
          }
          if (method === 'DELETE' && rest === '') {
            cloudMonitors.delete(monitor.id);
            return json(response, 204);
          }
          if (rest === '/samples') return json(response, 200, { items: monitor.samples ?? [] });
          if (rest === '/hours') return json(response, 200, { items: [] });
          if (rest.startsWith('/incidents')) {
            return json(response, 200, {
              items: [],
              page: 1,
              pageSize: 50,
              totalItems: 0,
              totalPages: 0,
            });
          }
          if (rest === '/mutes/me') {
            monitor.muted = method === 'PUT';
            return json(response, 204);
          }
          if (method === 'PUT' && rest === '/secrets/current') {
            monitor.secret = String(sentBody?.secret ?? '');
            return json(response, 204);
          }
        }
        if (method === 'GET' && path === '/api/v1/accounts/me/telegram-links/current') {
          return json(response, 200, {
            available: true,
            linked: false,
            botUsername: 'RunovaTestBot',
            chatName: null,
            linkedAt: null,
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
    /** The package lists the app sent, by `scopeId:itemId`. */
    inventories: () => [...inventories.values()],
    alertSettings: () => alertSettings,
    /** What the next read of the findings and the unread messages answer. */
    setFindings: (items: unknown[]) => {
      findings = { items };
    },
    setNotifications: (items: unknown[]) => {
      notifications = items;
    },
    /** The online monitors as the server holds them, with the key each was given. */
    cloudMonitors: () => [...cloudMonitors.values()],
    /** Every call to the online monitor routes, in order. */
    cloudCalls: () => cloudCalls,
    /** What the nodes found: the status the next read answers, and the sample it adds. */
    setCloudResult: (
      id: number,
      result: { state: string; latencyMs: number | null; region: string; problem?: string | null },
    ) => {
      const monitor = cloudMonitors.get(id);
      if (!monitor) throw new Error(`No online monitor ${id}`);
      const at = new Date().toISOString();
      const down = result.state !== 'pass' && result.state !== 'warn';
      monitor.status = {
        ...emptyStatus,
        verdict: down ? 'down' : 'up',
        state: result.state,
        lastCheckedAt: at,
        latencyMs: result.latencyMs,
        httpStatus: down ? 503 : 200,
        problem: result.problem ?? null,
        region: result.region,
        openIncident: down
          ? {
              id: 9,
              monitorId: id,
              openedAt: at,
              resolvedAt: null,
              state: result.state,
              problem: result.problem ?? null,
              region: result.region,
              confirmedFrom: null,
            }
          : null,
      };
      monitor.samples = [
        ...((monitor.samples as unknown[]) ?? []),
        {
          at,
          state: result.state,
          latencyMs: result.latencyMs,
          httpStatus: down ? 503 : 200,
          region: result.region,
          problem: result.problem ?? null,
        },
      ];
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeAccountServer = Awaited<ReturnType<typeof startFakeAccountServer>>;
