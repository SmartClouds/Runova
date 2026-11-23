import { StringDecoder } from 'node:string_decoder';
import { Client, type ClientChannel } from 'ssh2';
import { buildConnectConfig, friendlyConnectError, type SshEndpoint } from './connectConfig';

export interface SshConnectOptions extends SshEndpoint {
  cols?: number;
  rows?: number;
  /** Typed into the shell once it opens, e.g. a command that resumes an agent conversation. */
  initialInput?: string;
}

export interface SshSessionListener {
  onData: (sessionId: string, data: string) => void;
  onExit: (sessionId: string, error?: string) => void;
}

interface Session {
  client: Client;
  stream: ClientChannel;
}

export class SshSessionManager {
  private sessions = new Map<string, Session>();

  /** Idempotent: a session id already open is left alone rather than opening a second socket. */
  async create(
    sessionId: string,
    options: SshConnectOptions,
    listener: SshSessionListener,
  ): Promise<void> {
    if (this.sessions.has(sessionId)) return;

    const { config, verdict } = await buildConnectConfig(options);
    const client = new Client();

    try {
      await new Promise<void>((resolve, reject) => {
        client
          .on('ready', () => {
            client.shell(
              { cols: options.cols, rows: options.rows, term: 'xterm-256color' },
              (err, stream) => {
                if (err) {
                  reject(err);
                  return;
                }
                this.sessions.set(sessionId, { client, stream });
                // A chunk can end partway through a multi-byte character (box drawing, the
                // symbols agent CLIs draw with). Decoding each chunk on its own turned both
                // halves into replacement characters; a decoder carries the tail over instead.
                const stdout = new StringDecoder('utf8');
                const stderr = new StringDecoder('utf8');
                stream.on('data', (chunk: Buffer) => {
                  const text = stdout.write(chunk);
                  if (text) listener.onData(sessionId, text);
                });
                stream.stderr.on('data', (chunk: Buffer) => {
                  const text = stderr.write(chunk);
                  if (text) listener.onData(sessionId, text);
                });
                stream.on('close', () => {
                  this.sessions.delete(sessionId);
                  client.end();
                  listener.onExit(sessionId);
                });
                if (options.initialInput) stream.write(options.initialInput);
                resolve();
              },
            );
          })
          .on('error', (err) => {
            reject(friendlyConnectError(err, options, verdict));
          })
          .connect(config);
      });
    } catch (error) {
      this.sessions.delete(sessionId);
      client.end();
      throw error;
    }
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.stream.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.stream.setWindow(rows, cols, 0, 0);
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.stream.end();
    session.client.end();
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}
