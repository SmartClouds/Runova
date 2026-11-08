import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { createRelayOpener } from './relay';

/** Stands in for the website relay: pairs the two sockets of a session and copies bytes. */
function fakeRelay(options: { neverReady?: boolean } = {}) {
  const server = new WebSocketServer({ port: 0 });
  const waiting = new Map<string, WebSocket>();
  const seen: { path: string; ticket: string | null }[] = [];
  server.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://x');
    seen.push({ path: url.pathname, ticket: url.searchParams.get('ticket') });
    if (options.neverReady) return;
    const other = waiting.get(url.pathname);
    if (!other) {
      waiting.set(url.pathname, socket);
      return;
    }
    waiting.delete(url.pathname);
    socket.on('message', (data, isBinary) => other.send(data, { binary: isBinary }));
    other.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
    socket.on('close', () => other.close());
    other.on('close', () => socket.close());
    socket.send('ready');
    other.send('ready');
  });
  const port = (server.address() as AddressInfo).port;
  return { server, seen, siteUrl: `http://127.0.0.1:${port}` };
}

let relay: ReturnType<typeof fakeRelay> | null = null;
afterEach(() => {
  relay?.server.close();
  relay = null;
});

describe('relay links', () => {
  it('meets the other side through the relay with a one-time ticket and carries frames', async () => {
    relay = fakeRelay();
    const opener = createRelayOpener({
      siteUrl: relay.siteUrl,
      ticket: async (sessionId) => ({
        path: `/relay/remote/${sessionId}`,
        ticket: `t-${Math.random()}`,
      }),
    });

    const [controller, host] = await Promise.all([
      opener({ sessionId: 's1', role: 'controller' }),
      opener({ sessionId: 's1', role: 'host' }),
    ]);
    const heard = new Promise<number[]>((resolve) =>
      host.transport.onFrame((frame) => resolve([...frame])),
    );
    controller.transport.send(new Uint8Array([7, 7, 7]));

    expect(await heard).toEqual([7, 7, 7]);
    expect(controller.kind).toBe('relay');
    expect(controller.cipher).toBeTypeOf('function');
    expect(
      relay.seen.every((s) => s.path === '/relay/remote/s1' && s.ticket?.startsWith('t-')),
    ).toBe(true);
    controller.transport.close('done');
  });

  it('closes the other side when one side closes', async () => {
    relay = fakeRelay();
    const opener = createRelayOpener({
      siteUrl: relay.siteUrl,
      ticket: async (sessionId) => ({ path: `/relay/remote/${sessionId}`, ticket: 't' }),
    });
    const [controller, host] = await Promise.all([
      opener({ sessionId: 's2', role: 'controller' }),
      opener({ sessionId: 's2', role: 'host' }),
    ]);
    const closed = new Promise<string>((resolve) => host.transport.onClose(resolve));

    controller.transport.close('bye');

    await expect(closed).resolves.toBeTypeOf('string');
  });

  it('gives up when the other side never arrives', async () => {
    relay = fakeRelay({ neverReady: true });
    const opener = createRelayOpener({
      siteUrl: relay.siteUrl,
      ticket: async () => ({ path: '/relay/remote/s3', ticket: 't' }),
      readyTimeoutMs: 100,
    });

    await expect(opener({ sessionId: 's3', role: 'controller' })).rejects.toThrow(/relay/);
  });

  it('speaks wss to an https site', () => {
    expect(createRelayOpener.urlFor('https://runovahq.com', '/relay/remote/s', 'a b')).toBe(
      'wss://runovahq.com/relay/remote/s?ticket=a%20b',
    );
  });
});
