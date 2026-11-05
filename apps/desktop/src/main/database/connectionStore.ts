import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DB_ENGINES } from '@runova/core';
import { z } from 'zod';
import type { SecretEnvelope } from '../../shared/apiTypes';
import type {
  DatabaseConnection,
  DatabaseSaveInput,
  DatabaseTarget,
} from '../../shared/databaseTypes';
import {
  decryptSecret,
  encryptSecret,
  isLockedEnvelope,
  type SealedSecretStore,
} from '../ssh/vault';

/**
 * Saved database connections, in `databases.json` in the app's data folder. A password is only
 * on disk sealed with the Servers vault and moves with a passkey change. Every change goes through
 * one queue. A file that does not parse is refused rather than written over, and entries that do
 * not fit are dropped.
 */

export interface StoredDatabaseConnection
  extends Omit<DatabaseConnection, 'hasPassword' | 'locked'> {
  passwordEnvelope: SecretEnvelope | null;
  /** The container card this connection was made from ("server:<id>:<name>"), if any. */
  sourceKey: string | null;
  /** The team it is shared with through sync (E48). Missing means the person's own. */
  syncTeamId?: number;
}

interface FileState {
  connections: StoredDatabaseConnection[];
}

const engineSchema = z.enum(DB_ENGINES.map((info) => info.engine) as [string, ...string[]]);
const host = z.string().trim().min(1, 'Add the host name.').max(253);
const port = z.number().int().min(1).max(65535);
const shortText = z.string().max(256);

const targetSchema: z.ZodType<DatabaseTarget> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), host, port: port.nullable() }),
  z.object({
    kind: z.literal('server'),
    serverId: z.string().min(1).max(128),
    host,
    port,
    containerId: z.string().max(128).optional(),
    containerName: z.string().max(256).optional(),
  }),
  z.object({
    kind: z.literal('localContainer'),
    containerId: z.string().min(1).max(128),
    containerName: z.string().min(1).max(256),
    port,
  }),
  z.object({ kind: z.literal('sqliteFile'), path: z.string().min(1).max(4096) }),
]) as z.ZodType<DatabaseTarget>;

const envelopeSchema = z.union([
  z.object({ mode: z.literal('safeStorage'), ciphertext: z.string() }),
  z.object({
    mode: z.literal('passphrase'),
    iv: z.string(),
    authTag: z.string(),
    ciphertext: z.string(),
  }),
]);

const storedSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  engine: engineSchema,
  target: targetSchema,
  user: shortText.nullable(),
  database: shortText.nullable(),
  authDatabase: shortText.nullable(),
  tls: z.boolean(),
  srv: z.boolean(),
  readOnly: z.boolean(),
  passwordEnvelope: envelopeSchema.nullable(),
  sourceKey: z.string().max(512).nullable(),
  createdAt: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative().nullable(),
  syncTeamId: z.number().int().optional(),
});

function summary(stored: StoredDatabaseConnection): DatabaseConnection {
  const { passwordEnvelope, sourceKey: _source, syncTeamId: _team, ...rest } = stored;
  return {
    ...rest,
    hasPassword: passwordEnvelope !== null,
    locked: passwordEnvelope ? isLockedEnvelope(passwordEnvelope) : false,
  };
}

function cleanText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export class DatabaseConnectionStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  /** Moves every sealed password when the Servers passkey changes (see ssh/vault.ts). */
  readonly sealed: SealedSecretStore = {
    prepare: async (move) => {
      const moved = new Map<string, SecretEnvelope>();
      for (const connection of (await this.read()).connections) {
        if (connection.passwordEnvelope) {
          moved.set(connection.id, await move(connection.passwordEnvelope));
        }
      }
      return () =>
        this.mutate((state) => {
          for (const connection of state.connections) {
            const next = moved.get(connection.id);
            if (next) connection.passwordEnvelope = next;
          }
        });
    },
  };

  async list(): Promise<DatabaseConnection[]> {
    return (await this.read()).connections.map(summary);
  }

  async get(id: string): Promise<StoredDatabaseConnection> {
    const found = (await this.read()).connections.find((one) => one.id === id);
    if (!found) throw new Error('There is no saved connection with that id.');
    return found;
  }

  async summary(id: string): Promise<DatabaseConnection> {
    return summary(await this.get(id));
  }

  async bySource(sourceKey: string): Promise<StoredDatabaseConnection | null> {
    return (await this.read()).connections.find((one) => one.sourceKey === sourceKey) ?? null;
  }

  /** The saved password, opened. Undefined when there is none. */
  async password(id: string): Promise<string | undefined> {
    const envelope = (await this.get(id)).passwordEnvelope;
    return envelope ? decryptSecret(envelope) : undefined;
  }

  async save(
    input: DatabaseSaveInput,
    extra: { sourceKey?: string | null } = {},
  ): Promise<DatabaseConnection> {
    const name = input.name.trim();
    if (!name) throw new Error('Give the connection a name.');
    const target = targetSchema.parse(input.target);
    const engine = engineSchema.parse(input.engine) as DatabaseConnection['engine'];
    const envelope =
      input.password === undefined || input.password === ''
        ? null
        : await encryptSecret(input.password);
    return this.mutate((state) => {
      const existing = input.id ? state.connections.find((one) => one.id === input.id) : undefined;
      if (input.id && !existing) throw new Error('There is no saved connection with that id.');
      const next: StoredDatabaseConnection = {
        id: existing?.id ?? randomUUID(),
        name: name.slice(0, 200),
        engine,
        target,
        user: cleanText(input.user),
        database: cleanText(input.database),
        authDatabase: cleanText(input.authDatabase),
        tls: input.tls ?? false,
        srv: input.srv ?? false,
        readOnly: input.readOnly ?? false,
        passwordEnvelope:
          input.password === undefined ? (existing?.passwordEnvelope ?? null) : envelope,
        sourceKey: extra.sourceKey === undefined ? (existing?.sourceKey ?? null) : extra.sourceKey,
        createdAt: existing?.createdAt ?? Date.now(),
        lastUsedAt: existing?.lastUsedAt ?? null,
      };
      storedSchema.parse(next);
      if (existing) Object.assign(existing, next);
      else state.connections.push(next);
      return summary(next);
    });
  }

  /** Every connection as stored, sealed passwords included. For sync (E48). */
  async all(): Promise<StoredDatabaseConnection[]> {
    return (await this.read()).connections;
  }

  /**
   * Adds a connection as it is, or replaces the one with its id. For sync, which brings whole
   * records from another computer. Throws for one that does not fit, rather than store it.
   */
  async put(connection: StoredDatabaseConnection): Promise<void> {
    const next = storedSchema.parse(connection) as StoredDatabaseConnection;
    await this.mutate((state) => {
      const index = state.connections.findIndex((one) => one.id === next.id);
      if (index === -1) state.connections.push(next);
      else state.connections[index] = next;
    });
  }

  async touch(id: string, at = Date.now()): Promise<void> {
    await this.mutate((state) => {
      const found = state.connections.find((one) => one.id === id);
      if (found) found.lastUsedAt = at;
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate((state) => {
      state.connections = state.connections.filter((one) => one.id !== id);
    });
  }

  private async readUnqueued(): Promise<FileState> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { connections: [] };
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('databases.json is not valid JSON. Fix or remove it to use saved databases.');
    }
    const state: FileState = { connections: [] };
    const list = (value as { connections?: unknown })?.connections;
    for (const entry of Array.isArray(list) ? list : []) {
      const parsed = storedSchema.safeParse(entry);
      if (parsed.success && !state.connections.some((one) => one.id === parsed.data.id)) {
        state.connections.push(parsed.data as StoredDatabaseConnection);
      }
    }
    return state;
  }

  private async read(): Promise<FileState> {
    await this.queue;
    return this.readUnqueued();
  }

  private mutate<T>(change: (state: FileState) => T | Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const state = await this.readUnqueued();
      const before = JSON.stringify(state);
      const result = await change(state);
      if (JSON.stringify(state) !== before) await this.write(state);
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Written to a temporary name and renamed over, readable only by the user. */
  private async write(state: FileState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
