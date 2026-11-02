import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type { DatabaseHandlerDeps } from './database';
import { registerDatabaseHandlers } from './database';

/**
 * The Database section's channels answer only the main window and check every argument before
 * the service sees it.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const C = IPC.database;
const SESSION = '0f9c2b8e-1d6a-4f1b-9c3e-7a2d5e8b4c10';

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const service = Object.fromEntries(
    Object.keys(C).map((name) => [name, vi.fn(async () => 'ok')]),
  ) as unknown as Record<string, ReturnType<typeof vi.fn>>;
  const backups = {
    list: vi.fn(async () => []),
    backup: vi.fn(async () => ({})),
    restore: vi.fn(async () => undefined),
    restoreFromFile: vi.fn(async () => true),
    remove: vi.fn(async () => undefined),
    reveal: vi.fn(),
  };
  registerDatabaseHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    service: service as unknown as DatabaseHandlerDeps['service'],
    guard: () => trusted,
    backups,
  });
  const call = (channel: string, ...args: unknown[]) => {
    const listener = handlers.get(channel);
    if (!listener) throw new Error(`no handler for ${channel}`);
    return listener({} as IpcMainInvokeEvent, ...args);
  };
  return { handlers, service, backups, call };
}

describe('registerDatabaseHandlers', () => {
  it('handles every channel', () => {
    const { handlers } = harness();
    const invoked = Object.values(C).filter((channel) => !channel.includes(':on'));
    expect([...handlers.keys()].sort()).toEqual(invoked.sort());
  });

  it('answers only the main window', async () => {
    const { call, service } = harness(false);
    await expect(call(C.listConnections)).rejects.toThrow(/main window/);
    expect(service.listConnections).not.toHaveBeenCalled();
  });

  it('passes a checked connection through, password included', async () => {
    const { call, service } = harness();
    await call(C.saveConnection, {
      name: 'Shop',
      engine: 'postgres',
      target: { kind: 'direct', host: 'db.example.com', port: 5432 },
      user: 'app',
      database: null,
      readOnly: true,
      password: 'pw',
      extra: 'dropped',
    });
    expect(service.saveConnection).toHaveBeenCalledWith({
      name: 'Shop',
      engine: 'postgres',
      target: { kind: 'direct', host: 'db.example.com', port: 5432 },
      user: 'app',
      database: null,
      readOnly: true,
      password: 'pw',
    });
  });

  it.each([
    [{ name: 'x', engine: 'oracle', target: { kind: 'direct', host: 'h', port: 1 } }],
    [{ name: 'x', engine: 'redis', target: { kind: 'direct', host: 'h', port: 0 } }],
    [{ name: 'x', engine: 'redis', target: { kind: 'nowhere' } }],
    [{ name: '', engine: 'redis', target: { kind: 'direct', host: 'h', port: 1 } }],
    [
      {
        name: 'x',
        engine: 'redis',
        target: { kind: 'server', serverId: '../x', host: 'h', port: 1 },
      },
    ],
    [
      {
        name: 'x',
        engine: 'redis',
        target: { kind: 'localContainer', containerId: '--rm', containerName: 'a', port: 1 },
      },
    ],
  ])('turns down a connection that does not fit: %j', async (input) => {
    const { call, service } = harness();
    await expect(call(C.saveConnection, input)).rejects.toThrow();
    expect(service.saveConnection).not.toHaveBeenCalled();
  });

  it('checks a one-click connect, local or on a server', async () => {
    const { call, service } = harness();
    await call(C.connectCandidate, { serverId: null, containerId: 'dev-pg' });
    await call(C.connectCandidate, {
      serverId: 's1',
      containerId: 'abc',
      password: 'acct',
      databasePassword: '',
    });
    expect(service.connectCandidate).toHaveBeenNthCalledWith(1, {
      serverId: null,
      containerId: 'dev-pg',
    });
    expect(service.connectCandidate).toHaveBeenNthCalledWith(2, {
      serverId: 's1',
      containerId: 'abc',
      password: 'acct',
      databasePassword: '',
    });
    await expect(
      call(C.connectCandidate, { serverId: null, containerId: '-it' }),
    ).rejects.toThrow();
  });

  it('checks the sign-in channels, refusing an id that is not one', async () => {
    const { call, service } = harness();
    await call(C.listSignIns, { serverId: 's1', containerId: 'abc', totpCode: '123456' });
    expect(service.listSignIns).toHaveBeenCalledWith({
      serverId: 's1',
      containerId: 'abc',
      totpCode: '123456',
    });
    for (const channel of [C.connectSignIn, C.revealSignIn]) {
      await call(channel, { serverId: null, containerId: 'dev-pg', signInId: 'abc123def4567' });
    }
    expect(service.connectSignIn).toHaveBeenCalledWith({
      serverId: null,
      containerId: 'dev-pg',
      signInId: 'abc123def4567',
    });
    expect(service.revealSignIn).toHaveBeenCalledWith({
      serverId: null,
      containerId: 'dev-pg',
      signInId: 'abc123def4567',
    });
    for (const signInId of [
      undefined,
      '',
      'short',
      'UPPER1234567',
      '../../etc/passwd',
      'a'.repeat(33),
    ]) {
      await expect(
        call(C.revealSignIn, { serverId: null, containerId: 'dev-pg', signInId }),
      ).rejects.toThrow(/sign-in/);
    }
    await expect(call(C.listSignIns, { serverId: null, containerId: '-it' })).rejects.toThrow();
  });

  it('checks the discover, connect, disconnect and cancel arguments', async () => {
    const { call, service } = harness();
    await call(C.discover, { serverId: null });
    await call(C.discover, { serverId: 's1' });
    await call(C.connect, 'conn-1');
    await call(C.connect, 'conn-1', 'typed');
    await call(C.disconnect, SESSION);
    await call(C.cancelQuery, SESSION, 'q-1');
    await call(C.aiContext, { sessionId: SESSION, includeSamples: 'yes' });
    expect(service.aiContext).toHaveBeenCalledWith({ sessionId: SESSION, includeSamples: false });
    await call(C.settings, SESSION);
    await call(C.users, SESSION);
    expect(service.settings).toHaveBeenCalledWith(SESSION);
    expect(service.users).toHaveBeenCalledWith(SESSION);
    await expect(call(C.users, '../x')).rejects.toThrow();
    expect(service.discover).toHaveBeenCalledWith(null);
    expect(service.discover).toHaveBeenCalledWith('s1');
    expect(service.connect).toHaveBeenCalledWith('conn-1', undefined);
    expect(service.connect).toHaveBeenCalledWith('conn-1', 'typed');
    expect(service.disconnect).toHaveBeenCalledWith(SESSION);
    expect(service.cancelQuery).toHaveBeenCalledWith(SESSION, 'q-1');
    await expect(call(C.connect, 'a b')).rejects.toThrow();
    await expect(call(C.removeConnection, 42)).rejects.toThrow();
  });

  it('checks what to list, describe and read', async () => {
    const { call, service } = harness();
    await call(C.listObjects, { sessionId: SESSION, parent: null, parentKind: null });
    await call(C.listObjects, {
      sessionId: SESSION,
      parent: { database: 'shop', name: 'shop' },
      parentKind: 'database',
    });
    await call(C.describe, SESSION, { schema: 'public', name: 'items' });
    await call(C.readRows, {
      sessionId: SESSION,
      ref: { name: 'items' },
      limit: 100,
      offset: 0,
      filter: 'a > 1',
      orderBy: { column: 'id', direction: 'desc' },
    });
    expect(service.readRows).toHaveBeenCalledWith({
      sessionId: SESSION,
      ref: { name: 'items' },
      limit: 100,
      offset: 0,
      filter: 'a > 1',
      orderBy: { column: 'id', direction: 'desc' },
    });
    await expect(
      call(C.listObjects, { sessionId: SESSION, parent: null, parentKind: 'planet' }),
    ).rejects.toThrow();
    await expect(
      call(C.readRows, { sessionId: SESSION, ref: { name: 'x' }, limit: 0, offset: 0 }),
    ).rejects.toThrow();
    await expect(
      call(C.readRows, {
        sessionId: SESSION,
        ref: { name: 'x' },
        limit: 1,
        offset: 0,
        orderBy: { column: 'a', direction: 'sideways' },
      }),
    ).rejects.toThrow();
  });

  it('checks the backup channels, refusing names that leave the folder', async () => {
    const { call, backups } = harness();
    await call(C.listBackups, 'conn-1');
    await call(C.backup, 'conn-1');
    await call(C.restore, 'conn-1', 'shop-2026-01-01-000000.dump');
    await call(C.restoreFromFile, 'conn-1');
    await call(C.removeBackup, 'conn-1', 'shop-2026-01-01-000000.dump');
    await call(C.revealBackup, 'conn-1', 'shop-2026-01-01-000000.dump');
    expect(backups.restore).toHaveBeenCalledWith('conn-1', 'shop-2026-01-01-000000.dump');
    expect(backups.reveal).toHaveBeenCalled();
    await expect(call(C.restore, 'conn-1', '../../etc/passwd')).rejects.toThrow(/not a backup/);
    await expect(call(C.removeBackup, 'conn-1', '.hidden')).rejects.toThrow(/not a backup/);
  });

  it('checks a query', async () => {
    const { call, service } = harness();
    await call(C.query, {
      sessionId: SESSION,
      queryId: 'q1',
      text: 'SELECT 1',
      database: 'shop',
      maxRows: 500,
      origin: 'ai',
      confirmed: true,
    });
    expect(service.query).toHaveBeenCalledWith({
      sessionId: SESSION,
      queryId: 'q1',
      text: 'SELECT 1',
      database: 'shop',
      maxRows: 500,
      origin: 'ai',
      confirmed: true,
    });
    await expect(
      call(C.query, { sessionId: SESSION, queryId: 'q1', text: 'x'.repeat(1024 * 1024 + 1) }),
    ).rejects.toThrow(/1 MB/);
    await expect(
      call(C.query, { sessionId: SESSION, queryId: 'q1', text: 'x', origin: 'robot' }),
    ).rejects.toThrow();
    await expect(
      call(C.query, { sessionId: SESSION, queryId: 'q1', text: 'x', confirmed: 'yes' }),
    ).rejects.toThrow();
  });
});
