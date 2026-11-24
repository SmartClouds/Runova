import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import {
  createLineReader,
  encodeLine,
  type HelloResult,
  type HostMessage,
  type HostRequest,
  type ProveResult,
  PTY_HOST_PROTOCOL_VERSION,
  proofMatches,
} from './protocol';

export interface HostClientEvents {
  onData(sessionId: string, data: string): void;
  onExit(sessionId: string, exitCode: number): void;
  /** The connection dropped without close() being called (the host died or was killed). */
  onDisconnect(): void;
}

const REQUEST_TIMEOUT_MS = 10_000;

/** The host hung up on `prove`, as hosts from before the proof step do. */
export class LegacyHostError extends Error {
  constructor() {
    super('terminal host does not know the proof step');
    this.name = 'LegacyHostError';
  }
}

async function readToken(tokenFile: string): Promise<string> {
  return (await readFile(tokenFile, 'utf8')).trim();
}

function openSocket(endpoint: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const candidate = connect(endpoint);
    const timer = setTimeout(() => {
      candidate.destroy();
      reject(new Error('timed out connecting to terminal host'));
    }, 3000);
    candidate.once('connect', () => {
      clearTimeout(timer);
      candidate.removeListener('error', reject);
      resolve(candidate);
    });
    candidate.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** One authenticated connection from the app to the terminal host. */
export class HostClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedByUs = false;
  private events: HostClientEvents | null = null;

  private constructor(private readonly socket: Socket) {
    const read = createLineReader(
      (message) => this.dispatch(message as HostMessage),
      () => socket.destroy(),
    );
    socket.setNoDelay(true);
    socket.on('data', read);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('terminal host connection closed'));
      }
      this.pending.clear();
      if (!this.closedByUs) this.events?.onDisconnect();
    });
  }

  /**
   * Connects, checks the host holds the token, then says hello. Rejects if nothing is listening,
   * the host cannot prove itself or the token is wrong. The token is only sent after the proof, so
   * a process squatting on the predictable endpoint never gets it. A host from before the proof
   * step hangs up on `prove`, which rejects with LegacyHostError.
   */
  static async connect(
    endpoint: string,
    tokenFile: string,
  ): Promise<{ client: HostClient; hello: HelloResult }> {
    const token = await readToken(tokenFile);
    const client = new HostClient(await openSocket(endpoint));
    try {
      const nonce = randomBytes(32).toString('hex');
      let result: ProveResult | undefined;
      try {
        result = await client.request<ProveResult | undefined>({ type: 'prove', nonce }, 3000);
      } catch (error) {
        if (!client.connected) throw new LegacyHostError();
        throw error;
      }
      if (!proofMatches(token, nonce, result?.proof)) {
        throw new Error('terminal host could not prove it holds the token');
      }
      const hello = await client.request<HelloResult>(
        { type: 'hello', token, protocolVersion: PTY_HOST_PROTOCOL_VERSION },
        3000,
      );
      return { client, hello };
    } catch (error) {
      client.close();
      throw error;
    }
  }

  /**
   * Shuts down a host from before the proof step, shells and all. It is never used for anything
   * else, because it cannot prove it is the real host: it is only handed the token (stale anyway
   * when a squatter holds the endpoint, since the next real host writes a new one) and a shutdown.
   */
  static async retireLegacy(endpoint: string, tokenFile: string): Promise<void> {
    const token = await readToken(tokenFile);
    const client = new HostClient(await openSocket(endpoint));
    try {
      await client.request<HelloResult>(
        { type: 'hello', token, protocolVersion: PTY_HOST_PROTOCOL_VERSION },
        3000,
      );
      await client.request({ type: 'shutdown', payload: { killSessions: true } }, 2000);
    } finally {
      client.close();
    }
  }

  setEvents(events: HostClientEvents): void {
    this.events = events;
  }

  get connected(): boolean {
    return !this.socket.destroyed;
  }

  request<T>(message: HostRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.socket.destroyed) {
      return Promise.reject(new Error('terminal host is not connected'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`terminal host did not answer ${message.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket.write(encodeLine({ ...message, id }));
    });
  }

  /** Fire-and-forget, for keystrokes and resizes where waiting on a reply only adds lag. */
  notify(message: HostRequest): void {
    if (!this.socket.destroyed) this.socket.write(encodeLine(message));
  }

  /** Drops the connection. The host keeps every shell running. */
  close(): void {
    this.closedByUs = true;
    this.socket.destroy();
  }

  /** Waits until everything written so far has been handed to the OS, then disconnects. */
  closeAfterFlush(): Promise<void> {
    this.closedByUs = true;
    return new Promise((resolve) => {
      if (this.socket.destroyed) {
        resolve();
        return;
      }
      this.socket.once('close', () => resolve());
      this.socket.end();
      setTimeout(() => {
        this.socket.destroy();
        resolve();
      }, 1000).unref();
    });
  }

  private dispatch(message: HostMessage): void {
    if (message.kind === 'response') {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error));
      return;
    }
    if (message.event === 'data') this.events?.onData(message.sessionId, message.data);
    else this.events?.onExit(message.sessionId, message.exitCode);
  }
}
