import { readFile } from 'node:fs/promises';
import { Client, type ConnectConfig } from 'ssh2';
import type { SshAuthMethod } from '../../shared/apiTypes';
import { encodeSshError } from '../../shared/sshErrors';
import { type AccessRoute, openAccessStream } from './cloudflareAccess';

/**
 * How every SSH connection in the app is opened: terminal sessions, and the Deploy section's
 * exec, upload and tunnel connections. Only a host key the user trusted is accepted. A server
 * with no trusted key yet, or one that presents a different key, is refused before the login is
 * sent, with a coded error so the renderer can show the key and ask (`ssh:trustHostKey` stores
 * it).
 */

export interface SshEndpoint {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  /** Previously trusted host key fingerprint (SHA256, hex), if any. */
  storedFingerprint?: string;
  /**
   * SSH through the Cloudflare Tunnel (E95): the connection rides a WebSocket to the SSH hostname
   * behind Cloudflare Access instead of a TCP connection to host and port.
   */
  via?: { kind: 'cloudflare' } & AccessRoute;
}

/** What the handshake learned about the host key. */
export interface HostKeyVerdict {
  /** Set when no key was trusted yet: the fingerprint the server presented, refused. */
  unknown: string | null;
  /** Set when the server presented a different key from the stored one. */
  mismatch: { stored: string; presented: string } | null;
}

export class HostKeyChangedError extends Error {
  readonly stored: string;
  readonly presented: string;

  constructor(host: string, port: number, mismatch: { stored: string; presented: string }) {
    super(
      encodeSshError(
        'host-key-changed',
        `The host key for ${host}:${port} has changed since you last connected. If you did not ` +
          'reinstall or replace this server, treat this as a possible security warning.',
      ),
    );
    this.name = 'HostKeyChangedError';
    this.stored = mismatch.stored;
    this.presented = mismatch.presented;
  }
}

export class HostKeyUnknownError extends Error {
  readonly presented: string;

  constructor(host: string, port: number, presented: string) {
    super(
      encodeSshError(
        'host-key-unknown',
        `Runova has not connected to ${host}:${port} before, so its host key is not trusted ` +
          'yet. Check and trust the key first (opening the server in Remote asks about it). ' +
          'The login is not sent until then.',
      ),
    );
    this.name = 'HostKeyUnknownError';
    this.presented = presented;
  }
}

const READY_TIMEOUT_MS = 15_000;
const UNREACHABLE: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
const HUNG_UP: ReadonlySet<string> = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE']);

export async function buildConnectConfig(
  endpoint: SshEndpoint,
  extra: Partial<ConnectConfig> = {},
): Promise<{ config: ConnectConfig; verdict: HostKeyVerdict }> {
  const privateKey =
    endpoint.authMethod === 'privateKey' && endpoint.privateKeyPath
      ? await readFile(endpoint.privateKeyPath)
      : undefined;
  const verdict: HostKeyVerdict = { unknown: null, mismatch: null };
  const sock =
    endpoint.via?.kind === 'cloudflare' ? await openAccessStream(endpoint.via) : undefined;

  const config: ConnectConfig = {
    ...(sock ? { sock } : {}),
    host: endpoint.host,
    port: endpoint.port,
    username: endpoint.username,
    password: endpoint.authMethod === 'password' ? endpoint.password : undefined,
    privateKey,
    passphrase: endpoint.authMethod === 'privateKey' ? endpoint.passphrase : undefined,
    readyTimeout: READY_TIMEOUT_MS,
    hostHash: 'sha256',
    hostVerifier: (fingerprint: string): boolean => {
      // No trusted key is not trust: refuse before authenticating, so the login only goes to a
      // key the user looked at and trusted.
      if (!endpoint.storedFingerprint) {
        verdict.unknown = fingerprint;
        return false;
      }
      if (fingerprint === endpoint.storedFingerprint) return true;
      verdict.mismatch = { stored: endpoint.storedFingerprint, presented: fingerprint };
      return false;
    },
    ...extra,
  };
  return { config, verdict };
}

/** Turns an ssh2 connect failure into something a user, not a protocol log, can read. */
export function friendlyConnectError(
  error: NodeJS.ErrnoException & { level?: string },
  endpoint: Pick<SshEndpoint, 'host' | 'port'>,
  verdict: HostKeyVerdict,
): Error {
  const { host, port } = endpoint;
  if (verdict.mismatch) return new HostKeyChangedError(host, port, verdict.mismatch);
  if (verdict.unknown) return new HostKeyUnknownError(host, port, verdict.unknown);
  if (error.level === 'client-authentication') {
    return new Error('Authentication failed. Check the username, password, or private key.');
  }
  if (UNREACHABLE.has(error.code ?? '')) {
    return new Error(`Could not reach ${host}:${port}.`);
  }
  // A wrong port, or a service that is not SSH, tends to hang up on the handshake or answer in
  // something else. ssh2 words both as protocol errors.
  if (HUNG_UP.has(error.code ?? '') || error.message === 'Connection lost before handshake') {
    return new Error(
      `The connection to ${host}:${port} was closed by the other end while connecting. ` +
        'Check that the host and port belong to an SSH server.',
    );
  }
  if (
    error.message === 'Invalid identification string' ||
    /^Bad packet length/.test(error.message)
  ) {
    return new Error(`${host}:${port} does not look like an SSH server. Check the host and port.`);
  }
  // ssh2's own deadline (`readyTimeout`) for a server that connects but never finishes the login.
  if (error.code === 'ETIMEDOUT' || error.level === 'client-timeout') {
    return new Error(`Connection to ${host}:${port} timed out.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The server's host key fingerprint, read from the handshake alone. The probe refuses the key
 * on purpose, so it never gets as far as authenticating.
 */
export function probeHostKey(
  host: string,
  port: number,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let presented: string | null = null;
    const finish = (error?: Error): void => {
      client.end();
      if (presented) resolve(presented);
      else
        reject(
          friendlyConnectError(
            error ?? new Error('The server never sent a host key.'),
            { host, port },
            { unknown: null, mismatch: null },
          ),
        );
    };
    client.on('error', (error) => finish(error));
    client.on('ready', () => finish());
    client.connect({
      host,
      port,
      username: 'runova-host-key-probe',
      readyTimeout: timeoutMs,
      hostHash: 'sha256',
      hostVerifier: (fingerprint: string): boolean => {
        presented = fingerprint;
        return false;
      },
    });
  });
}
