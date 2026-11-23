import { afterEach, describe, expect, it, vi } from 'vitest';
import { sshErrorCode } from '../../shared/sshErrors';
import type { SshEndpoint } from './connectConfig';
import { SshConnection } from './connection';
import { type PoolSource, SshConnectionPool } from './pool';
import { type FakeSshServer, startFakeSshServer } from './testing/fakeSshServer';

/**
 * Deploy keeps one SSH connection per server and shares it between installs, tunnels and
 * commands, instead of logging in again for every step.
 */

const PASSWORD = 'correct horse battery staple';

let server: FakeSshServer | null = null;
let pool: SshConnectionPool | null = null;

afterEach(async () => {
  pool?.closeAll();
  pool = null;
  await server?.close();
  server = null;
});

/** `stored` is the trusted key, the server's own unless a test says otherwise; null for none. */
function sourceFor(fake: FakeSshServer, stored: string | null = fake.fingerprint()) {
  const connected: string[] = [];
  const source: PoolSource = {
    endpoint: async (serverId): Promise<SshEndpoint> => {
      if (serverId !== 'srv-1') throw new Error('This saved server no longer exists.');
      return {
        host: fake.host,
        port: fake.port,
        username: 'deploy',
        authMethod: 'password',
        password: PASSWORD,
        ...(stored ? { storedFingerprint: stored } : {}),
      };
    },
    connected: (serverId) => connected.push(serverId),
  };
  return { source, connected };
}

async function setup(options: { idleMs?: number; stored?: string | null } = {}) {
  server = await startFakeSshServer({ password: PASSWORD });
  const { source, connected } = sourceFor(server, options.stored);
  const open = vi.fn(SshConnection.open);
  pool = new SshConnectionPool(source, { open, idleMs: options.idleMs });
  return { server, pool, open, connected };
}

describe('SshConnectionPool', () => {
  it('shares one connection between callers', async () => {
    const { pool, open } = await setup();

    const [a, b] = await Promise.all([pool.acquire('srv-1'), pool.acquire('srv-1')]);
    const c = await pool.acquire('srv-1');

    expect(open).toHaveBeenCalledTimes(1);
    expect(a.connection).toBe(b.connection);
    expect(c.connection).toBe(a.connection);
    for (const lease of [a, b, c]) lease.release();
  });

  it('records the connect', async () => {
    const { pool, connected } = await setup();

    const lease = await pool.acquire('srv-1');

    expect(connected).toEqual(['srv-1']);
    lease.release();
  });

  it('refuses a server with no trusted key, before the login, and does not keep the failure', async () => {
    const { pool, server, connected } = await setup({ stored: null });

    for (const attempt of [() => pool.acquire('srv-1'), () => pool.openSeparate('srv-1')]) {
      const failure = await attempt().catch((error: unknown) => error);
      expect(sshErrorCode(failure)).toBe('host-key-unknown');
    }

    expect(server.authAttempts).toEqual([]);
    expect(connected).toEqual([]);
    expect(pool.isConnected('srv-1')).toBe(false);
  });

  it('opens a fresh connection after the old one dropped', async () => {
    const { pool, open, server } = await setup();
    const first = await pool.acquire('srv-1');
    first.release();

    first.connection.close();
    await vi.waitFor(() => expect(first.connection.isOpen).toBe(false));
    const second = await pool.acquire('srv-1');

    expect(open).toHaveBeenCalledTimes(2);
    expect(second.connection).not.toBe(first.connection);
    expect(second.connection.isOpen).toBe(true);
    expect(server.fingerprint()).toMatch(/^[0-9a-f]{64}$/);
    second.release();
  });

  it('logs in again after a reset, so new group memberships apply', async () => {
    const { pool, open } = await setup();
    const first = await pool.acquire('srv-1');

    pool.reset('srv-1');
    const second = await pool.acquire('srv-1');

    expect(first.connection.isOpen).toBe(false);
    expect(second.connection).not.toBe(first.connection);
    expect(open).toHaveBeenCalledTimes(2);
    second.release();
  });

  it('closes a connection nobody has used for a while', async () => {
    const { pool } = await setup({ idleMs: 50 });
    const lease = await pool.acquire('srv-1');

    lease.release();

    await vi.waitFor(() => expect(lease.connection.isOpen).toBe(false));
    expect(pool.isConnected('srv-1')).toBe(false);
  });

  it('keeps a connection that is still leased', async () => {
    const { pool } = await setup({ idleMs: 50 });
    const held = await pool.acquire('srv-1');
    const other = await pool.acquire('srv-1');

    other.release();
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(held.connection.isOpen).toBe(true);
    held.release();
  });

  it('does not remember a failed connect', async () => {
    const { pool, open } = await setup();

    await expect(pool.acquire('srv-missing')).rejects.toThrow(
      'This saved server no longer exists.',
    );
    const lease = await pool.acquire('srv-1');

    expect(open).toHaveBeenCalledTimes(1);
    lease.release();
  });

  it('opens a separate connection that nothing shares and that closes on release', async () => {
    const { pool, open, connected } = await setup();
    const shared = await pool.acquire('srv-1');
    const separate = await pool.openSeparate('srv-1');

    expect(open).toHaveBeenCalledTimes(2);
    expect(separate.connection).not.toBe(shared.connection);
    expect(connected).toEqual(['srv-1', 'srv-1']);
    const again = await pool.acquire('srv-1');
    expect(again.connection).toBe(shared.connection);

    separate.release();
    separate.release();
    await vi.waitFor(() => expect(separate.connection.isOpen).toBe(false));
    expect(shared.connection.isOpen).toBe(true);
    shared.release();
    again.release();
  });

  it('ignores a second release of the same lease', async () => {
    const { pool } = await setup({ idleMs: 50 });
    const a = await pool.acquire('srv-1');
    const b = await pool.acquire('srv-1');

    a.release();
    a.release();
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(b.connection.isOpen).toBe(true);
    b.release();
  });
});
