import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect as netConnect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebSocketStream, WebSocketServer } from 'ws';
import { sshErrorCode } from '../../shared/sshErrors';
import { openAccessStream } from './cloudflareAccess';
import { SshConnection } from './connection';
import { type FakeSshServer, startFakeSshServer } from './testing/fakeSshServer';

/**
 * SSH through the Cloudflare Tunnel (E95, "Cloudflare only"): the app opens a WebSocket to the
 * SSH hostname with the server's Access service token, and the bytes of the SSH connection ride
 * it as binary messages, the way `cloudflared access ssh` does. Here a local WebSocket server plays
 * Cloudflare's edge and cloudflared, relaying to an in-process SSH server.
 */

interface Edge {
  url: string;
  headers: IncomingHttpHeaders[];
  close: () => Promise<void>;
}

let edge: Edge | null = null;
let ssh: FakeSshServer | null = null;

afterEach(async () => {
  await edge?.close();
  await ssh?.close();
  edge = null;
  ssh = null;
});

/** Cloudflare's edge in front of cloudflared: refuses without the service token, relays with it. */
async function startEdge(target: number, clientId = 'id.access', secret = 'secret'): Promise<Edge> {
  const headers: IncomingHttpHeaders[] = [];
  const server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (info, done) => {
      headers.push(info.req.headers);
      const ok =
        info.req.headers['cf-access-client-id'] === clientId &&
        info.req.headers['cf-access-client-secret'] === secret;
      done(ok, ok ? undefined : 403, ok ? undefined : 'Forbidden');
    },
  });
  server.on('connection', (socket) => {
    const tcp = netConnect(target, '127.0.0.1');
    const stream = createWebSocketStream(socket);
    stream.pipe(tcp).pipe(stream);
    stream.on('error', () => tcp.destroy());
    tcp.on('error', () => stream.destroy());
  });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    headers,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('openAccessStream', () => {
  it('carries a whole SSH connection with the service token on the upgrade', async () => {
    ssh = await startFakeSshServer({ password: 'pw', exec: () => ({ stdout: 'hello\n' }) });
    edge = await startEdge(ssh.port);

    const connection = await SshConnection.open({
      host: 'ssh.example.com',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      password: 'pw',
      via: {
        kind: 'cloudflare',
        hostname: 'ssh.example.com',
        clientId: 'id.access',
        clientSecret: 'secret',
        url: edge.url,
      },
    });
    const result = await connection.exec('echo hello');
    connection.close();

    expect(result.stdout).toBe('hello\n');
    expect(edge.headers[0]?.['cf-access-client-id']).toBe('id.access');
    expect(edge.headers[0]?.['cf-access-client-secret']).toBe('secret');
  });

  it('says in words that Cloudflare Access refused the token, without repeating the secret', async () => {
    ssh = await startFakeSshServer({ password: 'pw' });
    edge = await startEdge(ssh.port, 'id.access', 'right');

    const failure = await openAccessStream({
      hostname: 'ssh.example.com',
      clientId: 'id.access',
      clientSecret: 'wrong-secret',
      url: edge.url,
    }).catch((error: unknown) => error as Error);

    expect(failure).toBeInstanceOf(Error);
    expect(sshErrorCode((failure as Error).message)).toBe('access-refused');
    expect((failure as Error).message).toContain('ssh.example.com');
    expect((failure as Error).message).not.toContain('wrong-secret');
  });

  it('gives up on an edge that never answers', async () => {
    const failure = await openAccessStream({
      hostname: 'ssh.example.com',
      clientId: 'id.access',
      clientSecret: 'secret',
      url: 'ws://127.0.0.1:9',
      timeoutMs: 2_000,
    }).catch((error: unknown) => error as Error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/ssh\.example\.com/);
  });

  it('only ever talks to the named host over TLS unless a test gives it a URL', async () => {
    const urls: string[] = [];
    await openAccessStream(
      { hostname: 'ssh.example.com', clientId: 'a', clientSecret: 'b', timeoutMs: 50 },
      (url) => {
        urls.push(url);
        throw new Error('stop');
      },
    ).catch(() => undefined);

    expect(urls).toEqual(['wss://ssh.example.com/']);
  });
});
