import { createServer, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * A port on 127.0.0.1 that carries each connection made to it over a stream the caller opens.
 * The Database section opens one per connection to a database on a server, so every driver
 * gets a plain host and port while the bytes travel inside the server's SSH connection.
 */

export interface LocalForward {
  host: '127.0.0.1';
  port: number;
  /** The last reason a stream could not open, for an error message better than "socket closed". */
  lastError: () => Error | null;
  close: () => Promise<void>;
}

export async function openLocalForward(open: () => Promise<Duplex>): Promise<LocalForward> {
  const sockets = new Set<Socket>();
  const streams = new Set<Duplex>();
  let lastError: Error | null = null;
  let closed = false;

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.pause();
    open().then(
      (stream) => {
        if (closed || socket.destroyed) {
          stream.destroy();
          return;
        }
        streams.add(stream);
        stream.on('close', () => {
          streams.delete(stream);
          socket.destroy();
        });
        stream.on('error', (error: Error) => {
          lastError = error;
          socket.destroy();
        });
        socket.on('close', () => stream.destroy());
        socket.pipe(stream);
        stream.pipe(socket);
        socket.resume();
      },
      (error: unknown) => {
        lastError = error instanceof Error ? error : new Error(String(error));
        socket.destroy();
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The local port did not open.');

  return {
    host: '127.0.0.1',
    port: address.port,
    lastError: () => lastError,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const stream of streams) stream.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
