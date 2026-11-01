import { connect, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLocalForward } from './forward';

/**
 * Database drivers want a host and a port. The forward gives them 127.0.0.1 and a free port, and
 * carries each connection over whatever stream the caller opens (an SSH channel in the app, a
 * plain socket here).
 */

let echo: Server | null = null;
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await new Promise<void>((resolve) => (echo ? echo.close(() => resolve()) : resolve()));
  echo = null;
});

async function startEcho(): Promise<number> {
  echo = createServer((socket) => {
    // Closing the forward can reset a connection that is still opening, so the echo's end may
    // see ECONNRESET. Left unhandled, that fails the whole run.
    socket.on('error', () => socket.destroy());
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => echo?.listen(0, '127.0.0.1', resolve));
  const address = echo.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

function talk(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, '127.0.0.1', () => socket.write(message));
    socket.once('data', (data) => {
      resolve(data.toString());
      socket.end();
    });
    socket.once('error', reject);
  });
}

describe('openLocalForward', () => {
  it('listens on loopback only and carries bytes both ways', async () => {
    const target = await startEcho();
    const forward = await openLocalForward(async () => connect(target, '127.0.0.1'));
    closers.push(forward.close);

    expect(forward.host).toBe('127.0.0.1');
    expect(forward.port).toBeGreaterThan(0);
    expect(await talk(forward.port, 'ping')).toBe('ping');
  });

  it('opens a new stream for every connection the driver makes', async () => {
    const target = await startEcho();
    const open = vi.fn(async () => connect(target, '127.0.0.1'));
    const forward = await openLocalForward(open);
    closers.push(forward.close);

    await talk(forward.port, 'a');
    await talk(forward.port, 'b');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('drops the connection when the stream cannot open, and keeps the error for the caller', async () => {
    const forward = await openLocalForward(async () => {
      throw new Error('Could not open a tunnel to 10.0.0.5:5432');
    });
    closers.push(forward.close);

    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(forward.port, '127.0.0.1');
      socket.on('close', () => resolve(true));
      socket.on('error', () => undefined);
    });
    expect(closed).toBe(true);
    expect(forward.lastError()?.message).toMatch(/could not open a tunnel/i);
  });

  it('closes every open connection and stops listening on close', async () => {
    const target = await startEcho();
    const forward = await openLocalForward(async () => connect(target, '127.0.0.1'));
    const socket = connect(forward.port, '127.0.0.1');
    // The forward destroys its end, which can reach this side as a reset.
    socket.on('error', () => undefined);
    await new Promise((resolve) => socket.once('connect', resolve));
    const ended = new Promise((resolve) => socket.once('close', resolve));

    await forward.close();
    await ended;
    await expect(talk(forward.port, 'x')).rejects.toThrow();
    // A second close is harmless.
    await forward.close();
  });
});
