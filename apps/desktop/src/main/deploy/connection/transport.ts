import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { quoteForShell } from '@runova/core';
import type { SshConnection } from '../../ssh/connection';
import { RUNOVA_CORE } from '../coreLayout';
import { asSocket, type SocketLike } from './socketShim';

/** Where the installer puts the core. */
export const CORE_SOCKET_PATH = RUNOVA_CORE.socketPath;
export const CORE_BINARY_PATH = RUNOVA_CORE.binaryPath;

export type CoreTransportKind = 'streamlocal' | 'bridge' | 'dev-tcp' | 'direct-tls' | 'core-domain';

/** A way to open a fresh byte stream to the core's HTTP listener. */
export interface CoreTransport {
  kind: CoreTransportKind;
  openStream: () => Promise<Duplex & SocketLike>;
  /** The Host header to send, when it is not the core's own name (a core domain). */
  host?: () => string;
  /**
   * The largest request body this way in carries, when it has a limit: Cloudflare's proxy refuses
   * larger ones (the core domain in Cloudflare mode, E44). A larger upload goes another way.
   */
  maxRequestBytes?: number;
}

/** The part of an SSH connection the transports need, so tests can hand in a fake. */
export type TunnelSource = Pick<SshConnection, 'openStream' | 'openExecStream'>;

/** A stream-local tunnel through sshd straight to the core's Unix socket. */
export function streamLocalTransport(
  source: TunnelSource,
  socketPath: string = CORE_SOCKET_PATH,
): CoreTransport {
  return {
    kind: 'streamlocal',
    openStream: async () => asSocket(await source.openStream({ socketPath })),
  };
}

/**
 * The core's own stdio bridge over an exec channel, for servers whose sshd forbids stream-local
 * forwarding. The bridge runs as the SSH user, who reaches the socket through the core's group.
 * Given no socket, the program uses its own.
 */
export function bridgeTransport(source: TunnelSource, socketPath?: string): CoreTransport {
  const socket = socketPath ? ` --socket ${quoteForShell(socketPath, 'posix')}` : '';
  // Through sh, whatever the login shell is.
  const command = `sh -c ${quoteForShell(`exec ${CORE_BINARY_PATH} bridge${socket}`, 'posix')}`;
  return {
    kind: 'bridge',
    openStream: async () => asSocket(await source.openExecStream(command)),
  };
}

/** Loopback TCP to the DevHost. Only development builds offer it (see `devCore.ts`). */
export function devTcpTransport(port: number, host = '127.0.0.1'): CoreTransport {
  return {
    kind: 'dev-tcp',
    openStream: () =>
      new Promise((resolve, reject) => {
        const socket = connect({ host, port });
        socket.once('connect', () => resolve(socket));
        socket.once('error', (error) =>
          reject(new Error(`Could not reach the DevHost on ${host}:${port}: ${error.message}`)),
        );
      }),
  };
}
