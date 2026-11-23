import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type Duplex, PassThrough } from 'node:stream';
import { type Connection, type ParsedKey, Server, type ServerChannel, utils } from 'ssh2';

/**
 * An in-process SSH server for tests: password and key login, a host key that can be swapped to
 * simulate a reinstalled server, a shell, exec with every request recorded, and TCP and Unix
 * socket forwarding. SFTP is left to the real OpenSSH container, whose behavior matters there.
 */

export interface ExecRequest {
  command: string;
  /** Everything the client wrote to the channel's stdin before closing it. */
  stdin: Buffer;
}

export interface ExecReply {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  exitCode?: number;
}

export type ExecHandler = (request: ExecRequest) => ExecReply | Promise<ExecReply>;

export interface FakeSshServerOptions {
  username?: string;
  password?: string;
  /** OpenSSH-format public key allowed to log in, from `generateClientKey()`. */
  authorizedKey?: string;
  exec?: ExecHandler;
  /**
   * Takes over an exec channel for a long-lived, two-way conversation (the core's stdio bridge).
   * Return true to claim the channel; otherwise `exec` answers it.
   */
  interactiveExec?: (command: string, channel: ServerChannel) => boolean;
  /**
   * 'prohibited' refuses every tunnel by policy (reason 1), as sshd does with
   * `AllowStreamLocalForwarding no`. Otherwise `forward` decides.
   */
  forwarding?: 'allowed' | 'prohibited';
  /**
   * Called for each forwarded connection; return a stream to pipe it to, or null to refuse it as
   * a failed connect (reason 2), as sshd does when nothing listens at the target.
   */
  forward?: (target: ForwardTarget) => Duplex | null;
  /**
   * Leaves requests of one kind unanswered, neither accepted nor refused, the way a server that
   * stopped responding does.
   */
  neverAnswer?: 'commands' | 'tunnels';
}

export type ForwardTarget =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'unix'; path: string };

export interface FakeSshServer {
  host: string;
  port: number;
  /** SHA-256 of the current host key, hex, the way ssh2's `hostHash: 'sha256'` reports it. */
  fingerprint: () => string;
  /** Replaces the host key on the same port, as if the server had been reinstalled. */
  rotateHostKey: () => Promise<void>;
  execRequests: ExecRequest[];
  /** The method of every login attempt the server received ('none', 'password', 'publickey'). */
  authAttempts: string[];
  /** Server-side shells, so a test can drive the far end of a session. */
  shells: ServerChannel[];
  close: () => Promise<void>;
}

export interface ClientKey {
  privateKey: string;
  publicKey: string;
}

/**
 * ECDSA P-256 rather than ed25519: ssh2's ed25519 generator emits a key its own parser rejects
 * about once in 250 tries ("Malformed OpenSSH private key"), which made tests flaky.
 */
function generateKeyPair(): { private: string; public: string } {
  return utils.generateKeyPairSync('ecdsa', { bits: 256 });
}

export function generateClientKey(): ClientKey {
  const pair = generateKeyPair();
  return { privateKey: pair.private, publicKey: pair.public };
}

function parseKey(key: string): ParsedKey {
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error) throw parsed;
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function fingerprintOf(publicKey: string): string {
  return createHash('sha256').update(parseKey(publicKey).getPublicSSH()).digest('hex');
}

/** Echoes whatever arrives, so a tunnel test can check bytes make the round trip. */
export function echoStream(): Duplex {
  return new PassThrough();
}

export async function startFakeSshServer(
  options: FakeSshServerOptions = {},
): Promise<FakeSshServer> {
  const username = options.username ?? 'deploy';
  const password = options.password ?? 'correct horse battery staple';
  const authorizedKey = options.authorizedKey ? parseKey(options.authorizedKey) : null;
  const execRequests: ExecRequest[] = [];
  const authAttempts: string[] = [];
  const shells: ServerChannel[] = [];
  const clients = new Set<Connection>();
  let hostKey = generateKeyPair();

  const makeServer = (): Server =>
    new Server({ hostKeys: [hostKey.private] }, (client) => {
      clients.add(client);
      client.on('close', () => clients.delete(client));
      client.on('error', () => undefined);
      client.on('authentication', (context) => {
        authAttempts.push(context.method);
        if (context.username !== username) return context.reject(['password', 'publickey']);
        if (context.method === 'password' && context.password === password) return context.accept();
        if (context.method === 'publickey' && authorizedKey) {
          const offered = context.key.data;
          if (!offered.equals(authorizedKey.getPublicSSH())) return context.reject();
          if (!context.signature) return context.accept();
          if (!context.blob) return context.reject();
          const valid = authorizedKey.verify(context.blob, context.signature, context.hashAlgo);
          return valid === true ? context.accept() : context.reject();
        }
        context.reject(['password', 'publickey']);
      });
      client.on('ready', () => {
        client.on('session', (acceptSession) => {
          const session = acceptSession();
          session.on('pty', (accept) => accept?.());
          session.on('window-change', (accept) => accept?.());
          session.on('env', (accept) => accept?.());
          session.on('shell', (accept) => {
            const shell = accept();
            shells.push(shell);
            shell.write('fake shell ready\r\n');
            shell.on('data', (data: Buffer) => shell.write(data));
          });
          session.on('exec', (accept, _reject, info) => {
            if (options.neverAnswer === 'commands') return;
            const channel = accept();
            if (options.interactiveExec?.(info.command, channel)) return;
            const chunks: Buffer[] = [];
            channel.on('data', (data: Buffer) => chunks.push(data));
            channel.on('end', async () => {
              const request: ExecRequest = { command: info.command, stdin: Buffer.concat(chunks) };
              execRequests.push(request);
              const reply = (await options.exec?.(request)) ?? {};
              if (reply.stdout) channel.write(reply.stdout);
              if (reply.stderr) channel.stderr.write(reply.stderr);
              channel.exit(reply.exitCode ?? 0);
              channel.end();
            });
          });
        });
        // With no handler, ssh2 refuses a tunnel by policy, which is what sshd does when
        // forwarding is switched off.
        if (options.forwarding === 'prohibited') return;
        client.on('tcpip', (accept, reject, info) => {
          const target = options.forward?.({ kind: 'tcp', host: info.destIP, port: info.destPort });
          if (!target) return reject();
          const channel = accept();
          channel.pipe(target).pipe(channel);
        });
        client.on('openssh.streamlocal', (accept, reject, info) => {
          if (options.neverAnswer === 'tunnels') return;
          const target = options.forward?.({ kind: 'unix', path: info.socketPath });
          if (!target) return reject();
          const channel = accept();
          channel.pipe(target).pipe(channel);
        });
      });
    });

  const listen = (target: Server, port: number): Promise<number> =>
    new Promise((resolve) => {
      target.listen(port, '127.0.0.1', () => resolve((target.address() as AddressInfo).port));
    });

  const closeServer = (target: Server): Promise<void> =>
    new Promise((resolve) => {
      for (const client of clients) client.end();
      target.close(() => resolve());
    });

  let server = makeServer();
  const port = await listen(server, 0);

  return {
    host: '127.0.0.1',
    port,
    fingerprint: () => fingerprintOf(hostKey.public),
    rotateHostKey: async () => {
      await closeServer(server);
      hostKey = generateKeyPair();
      server = makeServer();
      await listen(server, port);
    },
    execRequests,
    authAttempts,
    shells,
    close: () => closeServer(server),
  };
}
