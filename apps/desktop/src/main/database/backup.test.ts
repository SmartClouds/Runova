import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseConnection, DatabaseTarget } from '../../shared/databaseTypes';
import {
  type BackupSource,
  DatabaseBackups,
  type OpenProcess,
  type ProcessHandle,
  type RunWhere,
  whereToRun,
} from './backup';

/**
 * Backups stream from the engine's own tool straight into a file, with the password as the first
 * line of input and never on a command line. A failed backup leaves no half file behind.
 */

function fakeProcess(script: { stdout?: string; stderr?: string; code?: number }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const received: Buffer[] = [];
  stdin.on('data', (chunk: Buffer) => received.push(chunk));
  let resolveExit: (code: number | null) => void = () => undefined;
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });
  stdin.on('finish', () => {
    if (script.stderr) stderr.write(script.stderr);
    stdout.end(script.stdout ?? '');
    stderr.end();
    setTimeout(() => resolveExit(script.code ?? 0), 5);
  });
  const handle: ProcessHandle = { stdin, stdout, stderr, exited, kill: vi.fn() };
  return { handle, input: () => Buffer.concat(received).toString('utf-8') };
}

function connection(
  target: DatabaseTarget,
  overrides: Partial<DatabaseConnection> = {},
): DatabaseConnection {
  return {
    id: 'conn-1',
    name: 'Shop DB',
    engine: 'postgres',
    target,
    user: 'app',
    database: 'shop',
    authDatabase: null,
    tls: false,
    srv: false,
    readOnly: false,
    hasPassword: true,
    locked: false,
    createdAt: 1,
    lastUsedAt: null,
    ...overrides,
  };
}

function harness(
  open: OpenProcess,
  target: DatabaseTarget = {
    kind: 'localContainer',
    containerId: 'abc',
    containerName: 'shop-db',
    port: 5432,
  },
) {
  const folder = mkdtempSync(join(tmpdir(), 'runova-backups-'));
  const progress = vi.fn();
  const source: BackupSource = {
    connection: async () => connection(target),
    password: async () => 'pg-secret',
  };
  const backups = new DatabaseBackups({
    source,
    folder: () => folder,
    open,
    progress,
    now: () => new Date('2026-11-01T10:20:30Z').getTime(),
  });
  return { backups, folder, progress };
}

describe('whereToRun', () => {
  it('runs in the container, on the server, or locally, from the target', () => {
    expect(
      whereToRun({
        kind: 'server',
        serverId: 's1',
        host: '172.18.0.2',
        port: 5432,
        containerId: 'c1',
      }),
    ).toEqual({
      where: { kind: 'serverContainer', serverId: 's1', containerId: 'c1' },
      host: '127.0.0.1',
      port: 5432,
    });
    expect(whereToRun({ kind: 'server', serverId: 's1', host: '127.0.0.1', port: 5432 })).toEqual({
      where: { kind: 'server', serverId: 's1' },
      host: '127.0.0.1',
      port: 5432,
    });
    expect(
      whereToRun({ kind: 'localContainer', containerId: 'c2', containerName: 'x', port: 3306 }),
    ).toEqual({
      where: { kind: 'localContainer', containerId: 'c2' },
      host: '127.0.0.1',
      port: 3306,
    });
    expect(whereToRun({ kind: 'direct', host: 'db', port: 5432 })).toBeNull();
  });
});

describe('DatabaseBackups', () => {
  it('streams a backup into a dated file, sending the password as the first line only', async () => {
    const proc = fakeProcess({ stdout: 'PGDMP-binary-data' });
    const open = vi.fn(async (_where: RunWhere, _script: string) => proc.handle);
    const { backups, folder, progress } = harness(open);

    const file = await backups.backup('conn-1');

    expect(file).toMatchObject({
      name: 'Shop-DB-2026-11-01-102030.dump',
      size: 17,
      complete: true,
    });
    expect(readFileSync(join(folder, file.name), 'utf-8')).toBe('PGDMP-binary-data');
    expect(proc.input()).toBe('pg-secret\n');
    const [where, script] = open.mock.calls[0] ?? [];
    expect(where).toEqual({ kind: 'localContainer', containerId: 'abc' });
    expect(script).toContain('pg_dump');
    expect(script).not.toContain('pg-secret');
    expect(progress).toHaveBeenLastCalledWith({
      connectionId: 'conn-1',
      kind: 'backup',
      bytes: 17,
      done: true,
    });
  });

  it('removes the half-written file and reports the tool error when the backup fails', async () => {
    const proc = fakeProcess({
      stdout: 'partial',
      stderr: 'pg_dump: error: connection refused',
      code: 1,
    });
    const { backups, folder } = harness(async () => proc.handle);
    await expect(backups.backup('conn-1')).rejects.toThrow(/connection refused/);
    expect(readdirSync(folder)).toEqual([]);
  });

  it('lists backups newest first and deletes one by name only', async () => {
    const { backups, folder } = harness(async () => fakeProcess({}).handle);
    writeFileSync(join(folder, 'a-2026-01-01-000000.dump'), 'x');
    writeFileSync(join(folder, 'b-2026-02-01-000000.sql'), 'yy');
    const list = await backups.list('conn-1');
    expect(list.map((one) => one.name).sort()).toEqual([
      'a-2026-01-01-000000.dump',
      'b-2026-02-01-000000.sql',
    ]);
    await backups.remove('conn-1', 'a-2026-01-01-000000.dump');
    expect(existsSync(join(folder, 'a-2026-01-01-000000.dump'))).toBe(false);
    await expect(backups.remove('conn-1', '../outside.txt')).rejects.toThrow(/not a backup/i);
  });

  it('restores by sending the password, then the file, and waits for the tool', async () => {
    const proc = fakeProcess({});
    const { backups, folder, progress } = harness(async () => proc.handle);
    writeFileSync(join(folder, 'shop-2026-01-01-000000.dump'), 'DUMPDATA');
    await backups.restore('conn-1', { name: 'shop-2026-01-01-000000.dump' });
    expect(proc.input()).toBe('pg-secret\nDUMPDATA');
    expect(progress).toHaveBeenLastCalledWith({
      connectionId: 'conn-1',
      kind: 'restore',
      bytes: 8,
      done: true,
    });
  });

  it('reports a restore the tool refused', async () => {
    const proc = fakeProcess({
      stderr: 'pg_restore: error: input file is not a valid archive',
      code: 1,
    });
    const { backups, folder } = harness(async () => proc.handle);
    writeFileSync(join(folder, 'x-2026-01-01-000000.dump'), 'junk');
    await expect(backups.restore('conn-1', { name: 'x-2026-01-01-000000.dump' })).rejects.toThrow(
      /not a valid archive/,
    );
  });

  it('says a direct connection cannot use the native tools', async () => {
    const { backups } = harness(async () => fakeProcess({}).handle, {
      kind: 'direct',
      host: 'db',
      port: 5432,
    });
    await expect(backups.backup('conn-1')).rejects.toThrow(/container or a server/i);
  });
});
