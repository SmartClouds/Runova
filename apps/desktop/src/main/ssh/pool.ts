import type { SshEndpoint } from './connectConfig';
import { SshConnection, type SshConnectionHooks } from './connection';

/**
 * One SSH connection per saved server, shared by everything that needs it (installs, tunnels,
 * commands) and closed after a quiet spell. A dropped connection is replaced on the next use.
 */

export interface PoolSource {
  /** The endpoint for a saved server, secrets decrypted. Throws when it is gone or locked. */
  endpoint: (serverId: string) => Promise<SshEndpoint>;
  /** Called after every successful login, for "last connected" bookkeeping. */
  connected?: (serverId: string) => void;
}

export type SshOpener = (
  endpoint: SshEndpoint,
  hooks: SshConnectionHooks,
) => Promise<SshConnection>;

export interface SshLease {
  readonly connection: SshConnection;
  /** Hands the connection back. Safe to call more than once. */
  release: () => void;
}

interface Entry {
  connection: Promise<SshConnection>;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_IDLE_MS = 60_000;

export class SshConnectionPool {
  private readonly entries = new Map<string, Entry>();
  private readonly open: SshOpener;
  private readonly idleMs: number;

  constructor(
    private readonly source: PoolSource,
    options: { open?: SshOpener; idleMs?: number } = {},
  ) {
    this.open = options.open ?? SshConnection.open;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  }

  async acquire(serverId: string): Promise<SshLease> {
    let entry = this.entries.get(serverId);
    if (entry && !(await this.isUsable(entry))) {
      this.forget(serverId, entry);
      entry = undefined;
    }
    if (!entry) {
      entry = { connection: this.connect(serverId), refs: 0, idleTimer: null };
      this.entries.set(serverId, entry);
    }

    const current = entry;
    current.refs += 1;
    if (current.idleTimer) {
      clearTimeout(current.idleTimer);
      current.idleTimer = null;
    }
    let connection: SshConnection;
    try {
      connection = await current.connection;
    } catch (error) {
      current.refs -= 1;
      this.forget(serverId, current);
      throw error;
    }

    let released = false;
    return {
      connection,
      release: () => {
        if (released) return;
        released = true;
        this.release(serverId, current);
      },
    };
  }

  /**
   * A connection of its own, outside the pool: nothing else shares it, and releasing it closes
   * it. For what must prove a new login still gets in, such as confirming a firewall change.
   */
  async openSeparate(serverId: string): Promise<SshLease> {
    const endpoint = await this.source.endpoint(serverId);
    const connection = await this.open(endpoint, {});
    this.source.connected?.(serverId);
    let released = false;
    return {
      connection,
      release: () => {
        if (released) return;
        released = true;
        connection.close();
      },
    };
  }

  /** Closes the server's connection, so the next `acquire` logs in again. */
  reset(serverId: string): void {
    const entry = this.entries.get(serverId);
    if (entry) this.forget(serverId, entry);
  }

  isConnected(serverId: string): boolean {
    return this.entries.has(serverId);
  }

  closeAll(): void {
    for (const [serverId, entry] of [...this.entries]) this.forget(serverId, entry);
  }

  private async connect(serverId: string): Promise<SshConnection> {
    const endpoint = await this.source.endpoint(serverId);
    let connection: SshConnection | null = null;
    connection = await this.open(endpoint, {
      onClose: () => {
        const entry = this.entries.get(serverId);
        if (entry) {
          void entry.connection.then((open) => {
            if (open === connection) this.forget(serverId, entry);
          });
        }
      },
    });
    this.source.connected?.(serverId);
    return connection;
  }

  private async isUsable(entry: Entry): Promise<boolean> {
    try {
      return (await entry.connection).isOpen;
    } catch {
      return false;
    }
  }

  private release(serverId: string, entry: Entry): void {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0 || this.entries.get(serverId) !== entry) return;
    entry.idleTimer = setTimeout(() => this.forget(serverId, entry), this.idleMs);
  }

  private forget(serverId: string, entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (this.entries.get(serverId) === entry) this.entries.delete(serverId);
    void entry.connection.then(
      (connection) => connection.close(),
      () => undefined,
    );
  }
}
