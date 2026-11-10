import { createServer, type Server } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNOVA_CORE } from '../coreLayout';
import {
  bridgeTransport,
  CORE_SOCKET_PATH,
  devTcpTransport,
  streamLocalTransport,
  type TunnelSource,
} from './transport';

/**
 * How the app reaches the core: a stream-local tunnel to its socket, the stdio bridge when sshd
 * forbids that, or (development builds only) plain loopback TCP to the DevHost.
 */

function tunnelSource(): TunnelSource & { streams: PassThrough[] } {
  const streams: PassThrough[] = [];
  const next = async () => {
    const stream = new PassThrough();
    streams.push(stream);
    return stream;
  };
  return {
    streams,
    openStream: vi.fn(next),
    openExecStream: vi.fn(next),
  };
}

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

describe('streamLocalTransport', () => {
  it('opens a fresh tunnel to the core socket for every stream', async () => {
    const source = tunnelSource();
    const transport = streamLocalTransport(source);

    await transport.openStream();
    await transport.openStream();

    expect(source.openStream).toHaveBeenCalledTimes(2);
    expect(source.openStream).toHaveBeenCalledWith({ socketPath: CORE_SOCKET_PATH });
    expect(transport.kind).toBe('streamlocal');
  });

  it('passes on a failed tunnel at once', async () => {
    const source = tunnelSource();
    (source.openStream as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection lost'));

    await expect(streamLocalTransport(source).openStream()).rejects.toThrow('connection lost');
    expect(source.openStream).toHaveBeenCalledTimes(1);
  });
});

describe('bridgeTransport', () => {
  it('runs the core bridge over an exec channel', async () => {
    const source = tunnelSource();
    const transport = bridgeTransport(source);

    const stream = await transport.openStream();

    expect(source.openExecStream).toHaveBeenCalledWith(
      `sh -c 'exec ${RUNOVA_CORE.binaryPath} bridge'`,
    );
    expect(typeof stream.setNoDelay).toBe('function');
    expect(transport.kind).toBe('bridge');
  });

  it('quotes an unusual socket path', async () => {
    const source = tunnelSource();

    await bridgeTransport(source, "/run/it's here/core.sock").openStream();

    const command = (source.openExecStream as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(command).toContain('bridge --socket ');
    expect(command).toContain('here/core.sock');
    expect(command.startsWith("sh -c '")).toBe(true);
  });
});

describe('devTcpTransport', () => {
  it('connects to the DevHost on loopback', async () => {
    server = createServer((socket) => socket.pipe(socket));
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });

    const stream = await devTcpTransport(port).openStream();
    const echoed = new Promise<string>((resolve) =>
      stream.once('data', (chunk) => resolve(String(chunk))),
    );
    stream.write('hi');

    expect(await echoed).toBe('hi');
    stream.destroy();
  });

  it('explains a DevHost that is not running', async () => {
    await expect(devTcpTransport(1).openStream()).rejects.toThrow(/DevHost/);
  });
});
