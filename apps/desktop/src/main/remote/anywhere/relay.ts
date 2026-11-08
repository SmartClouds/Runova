import { WebSocket } from 'ws';
import type { LinkTransport } from './link';
import type { OpenedLink } from './links';
import { createFrameCipher } from './relayCipher';
import type { RelayOpener } from './rtcLinks';

const READY_TIMEOUT_MS = 30_000;
/** The relay takes frames up to this size; a link frame is 60 KiB plus the cipher's 24 bytes. */
const MAX_FRAME = 128 * 1024;

/**
 * Runova Anywhere's relay links (E62): when the two computers can not reach each other directly,
 * both open a WebSocket to the website's relay with a one-time ticket from the hub, and the relay
 * copies bytes between them. Every frame is sealed with the session keys from the handshake (see
 * {@link createFrameCipher}), so the relay sees how much is sent and when, and nothing else.
 */
export function createRelayOpener(input: {
  siteUrl: string;
  ticket(sessionId: string): Promise<{ path: string; ticket: string }>;
  readyTimeoutMs?: number;
}): RelayOpener {
  return async ({ sessionId }) => {
    const { path, ticket } = await input.ticket(sessionId);
    const socket = new WebSocket(createRelayOpener.urlFor(input.siteUrl, path, ticket), {
      maxPayload: MAX_FRAME,
    });
    socket.binaryType = 'nodebuffer';

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('The relay did not connect the other computer in time.'));
      }, input.readyTimeoutMs ?? READY_TIMEOUT_MS);
      const failed = (reason: string) => {
        clearTimeout(timer);
        reject(new Error(`The relay refused the connection (${reason}).`));
      };
      socket.once('error', (error) => failed(error.message));
      socket.once('close', (code) => failed(`closed ${code}`));
      socket.once('message', (data, isBinary) => {
        clearTimeout(timer);
        socket.removeAllListeners('close');
        socket.removeAllListeners('error');
        if (!isBinary && data.toString() === 'ready') resolve();
        else {
          socket.close();
          reject(new Error('The relay sent something unexpected.'));
        }
      });
    });

    return {
      transport: socketTransport(socket),
      kind: 'relay',
      localFingerprint: '',
      remoteFingerprint: '',
      cipher: (keys) => createFrameCipher(keys),
    } satisfies OpenedLink;
  };
}

createRelayOpener.urlFor = (siteUrl: string, path: string, ticket: string): string => {
  const url = new URL(path, siteUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = `?ticket=${encodeURIComponent(ticket)}`;
  return url.toString();
};

function socketTransport(socket: WebSocket): LinkTransport {
  const frameListeners: ((frame: Uint8Array) => void)[] = [];
  const closeListeners: ((reason: string) => void)[] = [];
  let closed = false;
  const shut = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener(reason);
  };
  socket.on('message', (data: Buffer, isBinary) => {
    if (!isBinary) return;
    const frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (const listener of frameListeners) listener(frame);
  });
  socket.on('close', () => shut('the relay closed'));
  socket.on('error', (error) => shut(error.message));
  return {
    send: (frame) => {
      if (!closed && socket.readyState === WebSocket.OPEN) socket.send(frame, { binary: true });
    },
    bufferedAmount: () => socket.bufferedAmount,
    close: (reason) => {
      socket.close(1000);
      shut(reason);
    },
    onFrame: (listener) => frameListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
  };
}
