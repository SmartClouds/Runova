import type { Duplex } from 'node:stream';
import WebSocket, { type ClientOptions, createWebSocketStream } from 'ws';
import { encodeSshError } from '../../shared/sshErrors';

/**
 * SSH through the Cloudflare Tunnel (E95, "Cloudflare only" SSH). The server's sshd has no open
 * port; cloudflared on the server routes the SSH hostname to it, and Cloudflare Access only lets a
 * request through with the server's service token. The app does what `cloudflared access ssh`
 * does: a WebSocket to the hostname with the token's two headers, the SSH bytes riding it as
 * binary messages. ssh2 then runs over that stream as over a socket, host key pinning and all.
 */

export interface AccessRoute {
  hostname: string;
  clientId: string;
  clientSecret: string;
  /** Only tests set this, to reach a local stand-in for Cloudflare's edge. */
  url?: string;
  timeoutMs?: number;
}

export type AccessSocketFactory = (url: string, options: ClientOptions) => WebSocket;

const DEFAULT_TIMEOUT_MS = 15_000;

const defaultFactory: AccessSocketFactory = (url, options) => new WebSocket(url, options);

/** Opens the stream, or fails with words a person can act on (never the secret). */
export function openAccessStream(
  route: AccessRoute,
  factory: AccessSocketFactory = defaultFactory,
): Promise<Duplex> {
  const url = route.url ?? `wss://${route.hostname}/`;
  const timeoutMs = route.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<Duplex>((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = factory(url, {
        headers: {
          'CF-Access-Client-Id': route.clientId,
          'CF-Access-Client-Secret': route.clientSecret,
        },
        handshakeTimeout: timeoutMs,
        followRedirects: false,
        perMessageDeflate: false,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new Error(message));
    };
    socket.binaryType = 'nodebuffer';
    socket.once('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      if (status === 401 || status === 403) {
        fail(
          encodeSshError(
            'access-refused',
            `Cloudflare Access refused this computer's service token for ${route.hostname}. Set SSH up again from the Cloudflare Tunnel card, or open SSH to everyone from the server's console.`,
          ),
        );
        return;
      }
      fail(
        `Cloudflare answered ${status} for ${route.hostname} instead of opening SSH. Check that the tunnel is connected and routes this name to SSH.`,
      );
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      fail(
        `Could not reach ${route.hostname} through Cloudflare (${error.code ?? error.message}). Check this computer's connection and that the name is on Cloudflare.`,
      );
    });
    socket.once('open', () => {
      if (settled) return;
      settled = true;
      resolve(createWebSocketStream(socket));
    });
  });
}
