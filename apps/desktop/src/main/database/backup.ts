import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { backupPlan, type DumpPlan, restorePlan, shQuote } from '@runova/core';
import type {
  DatabaseBackupFile,
  DatabaseBackupProgress,
  DatabaseConnection,
  DatabaseTarget,
} from '../../shared/databaseTypes';

/**
 * Backups and restores with the engine's own tools, run where the database lives: inside its
 * container (on a server over SSH, or in Docker here), or on the server itself. The script reads
 * the password from its first line of input, so it is never on a command line. Backups land in
 * one folder per connection; a failed one leaves nothing behind.
 */

export type RunWhere =
  | { kind: 'serverContainer'; serverId: string; containerId: string }
  | { kind: 'server'; serverId: string }
  | { kind: 'localContainer'; containerId: string };

export interface ProcessHandle {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<number | null>;
  kill: () => void;
}

export type OpenProcess = (where: RunWhere, script: string) => Promise<ProcessHandle>;

export interface BackupSource {
  connection: (connectionId: string) => Promise<DatabaseConnection>;
  password: (connectionId: string) => Promise<string | undefined>;
}

export interface DatabaseBackupsDeps {
  source: BackupSource;
  folder: (connectionId: string) => string;
  open: OpenProcess;
  progress: (event: DatabaseBackupProgress) => void;
  now?: () => number;
}

const MAX_STDERR = 64 * 1024;
const BACKUP_NAME = /^[A-Za-z0-9._-]{1,200}$/;
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/** Where the tool runs for a connection, and the address it uses from there. */
export function whereToRun(
  target: DatabaseTarget,
): { where: RunWhere; host: string; port: number } | null {
  switch (target.kind) {
    case 'server':
      return target.containerId
        ? {
            where: {
              kind: 'serverContainer',
              serverId: target.serverId,
              containerId: target.containerId,
            },
            host: '127.0.0.1',
            port: target.port,
          }
        : {
            where: { kind: 'server', serverId: target.serverId },
            host: target.host,
            port: target.port,
          };
    case 'localContainer':
      return {
        where: { kind: 'localContainer', containerId: target.containerId },
        host: '127.0.0.1',
        port: target.port,
      };
    default:
      return null;
  }
}

/** The command a server runs for a script: in a container through docker (with sudo if needed). */
export function serverCommand(
  where: Exclude<RunWhere, { kind: 'localContainer' }>,
  script: string,
): string {
  if (where.kind === 'server') return `sh -c ${shQuote(script)}`;
  if (!CONTAINER.test(where.containerId)) throw new Error('That is not a container.');
  return `if docker info >/dev/null 2>&1; then D=docker; else D="sudo -n docker"; fi; exec $D exec -i ${where.containerId} sh -c ${shQuote(script)}`;
}

/** A local `docker exec -i` for a script. */
export function localProcess(containerId: string, script: string): ProcessHandle {
  if (!CONTAINER.test(containerId)) throw new Error('That is not a container.');
  const child = spawn('docker', ['exec', '-i', containerId, 'sh', '-c', script], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill: () => child.kill(),
  };
}

function stamp(at: number): string {
  const date = new Date(at);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}-${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}`;
}

function safeName(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'database'
  );
}

function collect(stream: Readable): () => string {
  let text = '';
  stream.on('data', (chunk: Buffer) => {
    if (text.length < MAX_STDERR) text += chunk.toString('utf-8');
  });
  return () => text.trim();
}

function failure(stderr: string, code: number | null, what: string): Error {
  const lines = stderr.split('\n').filter((line) => line.trim());
  const last = lines.slice(-4).join('\n');
  return new Error(
    last ? `The ${what} failed: ${last}` : `The ${what} failed (exit code ${code ?? 'none'}).`,
  );
}

export class DatabaseBackups {
  private readonly now: () => number;

  constructor(private readonly deps: DatabaseBackupsDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async plan(connectionId: string, kind: 'backup' | 'restore') {
    const connection = await this.deps.source.connection(connectionId);
    const place = whereToRun(connection.target);
    if (!place) {
      throw new Error(
        'Backups run the database tools where the database lives, so they work for databases in a container or a server. Use a query export for this connection.',
      );
    }
    const options = {
      engine: connection.engine,
      ...(connection.user ? { user: connection.user } : {}),
      ...(connection.database ? { database: connection.database } : {}),
      ...(connection.authDatabase ? { authDatabase: connection.authDatabase } : {}),
      host: place.host,
      port: place.port,
    };
    const plan: DumpPlan = kind === 'backup' ? backupPlan(options) : restorePlan(options);
    const password = plan.passwordOnStdin
      ? ((await this.deps.source.password(connectionId)) ?? '')
      : '';
    return { connection, place, plan, password };
  }

  async list(connectionId: string): Promise<DatabaseBackupFile[]> {
    const folder = this.deps.folder(connectionId);
    let names: string[];
    try {
      names = await readdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const files: DatabaseBackupFile[] = [];
    for (const name of names) {
      if (!BACKUP_NAME.test(name) || name.endsWith('.partial')) continue;
      const info = await stat(join(folder, name)).catch(() => null);
      if (!info?.isFile()) continue;
      files.push({
        name,
        size: info.size,
        createdAt: info.mtimeMs,
        complete: !name.endsWith('.cql'),
      });
    }
    return files.sort((a, b) => b.createdAt - a.createdAt);
  }

  async backup(connectionId: string): Promise<DatabaseBackupFile> {
    const { connection, place, plan, password } = await this.plan(connectionId, 'backup');
    const folder = this.deps.folder(connectionId);
    await mkdir(folder, { recursive: true });
    const name = `${safeName(connection.name)}-${stamp(this.now())}.${plan.extension}`;
    const file = join(folder, name);
    const partial = `${file}.partial`;
    const process = await this.deps.open(place.where, plan.script);
    const stderr = collect(process.stderr);
    let bytes = 0;
    let lastReport = 0;
    process.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (Date.now() - lastReport > 250) {
        lastReport = Date.now();
        this.deps.progress({ connectionId, kind: 'backup', bytes, done: false });
      }
    });
    try {
      process.stdin.end(plan.passwordOnStdin ? `${password}\n` : '');
      await pipeline(process.stdout, createWriteStream(partial, { mode: 0o600 }));
      const code = await process.exited;
      if (code !== 0) throw failure(stderr(), code, 'backup');
      await rename(partial, file);
    } catch (error) {
      process.kill();
      await rm(partial, { force: true }).catch(() => undefined);
      throw error;
    }
    this.deps.progress({ connectionId, kind: 'backup', bytes, done: true });
    const info = await stat(file);
    return { name, size: info.size, createdAt: info.mtimeMs, complete: plan.complete };
  }

  /** Restores from a backup in the connection's folder, or a file the user picked. */
  async restore(connectionId: string, from: { name: string } | { path: string }): Promise<void> {
    const path = 'name' in from ? this.fileIn(connectionId, from.name) : from.path;
    const size = (await stat(path)).size;
    const { place, plan, password } = await this.plan(connectionId, 'restore');
    const process = await this.deps.open(place.where, plan.script);
    const stderr = collect(process.stderr);
    process.stdout.resume();
    let bytes = 0;
    const input = createReadStream(path);
    input.on('data', (chunk: Buffer | string) => {
      bytes += chunk.length;
      this.deps.progress({
        connectionId,
        kind: 'restore',
        bytes: Math.min(bytes, size),
        done: false,
      });
    });
    try {
      if (plan.passwordOnStdin) process.stdin.write(`${password}\n`);
      await pipeline(input, process.stdin);
      const code = await process.exited;
      if (code !== 0) throw failure(stderr(), code, 'restore');
    } catch (error) {
      process.kill();
      throw error;
    }
    this.deps.progress({ connectionId, kind: 'restore', bytes: size, done: true });
  }

  async remove(connectionId: string, name: string): Promise<void> {
    await rm(this.fileIn(connectionId, name), { force: true });
  }

  /** The full path of a backup, refusing any name that could reach outside its folder. */
  fileIn(connectionId: string, name: string): string {
    if (!BACKUP_NAME.test(name) || name !== basename(name) || name.startsWith('.')) {
      throw new Error('That is not a backup of this connection.');
    }
    return join(this.deps.folder(connectionId), name);
  }
}
