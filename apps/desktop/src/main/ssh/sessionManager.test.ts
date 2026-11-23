import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sshErrorCode } from '../../shared/sshErrors';
import { tempDir } from '../../test/main/fixtures';
import { type SshSessionListener, SshSessionManager } from './sessionManager';
import { type FakeSshServer, generateClientKey, startFakeSshServer } from './testing/fakeSshServer';

/**
 * Pins how interactive SSH terminal sessions behave, so moving the connect logic into a shared
 * module (for Deploy) cannot quietly change what the Remote section's terminals do.
 */

const PASSWORD = 'correct horse battery staple';

let server: FakeSshServer | null = null;
const manager = new SshSessionManager();

afterEach(async () => {
  manager.killAll();
  await server?.close();
  server = null;
});

function listener(): SshSessionListener & {
  data: string[];
  exits: Array<string | undefined>;
} {
  const data: string[] = [];
  const exits: Array<string | undefined> = [];
  return {
    data,
    exits,
    onData: (_id, chunk) => data.push(chunk),
    onExit: (_id, error) => exits.push(error),
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!check()) throw new Error('not yet');
  });
}

describe('SshSessionManager', () => {
  it('opens a shell with a password and streams its output', async () => {
    server = await startFakeSshServer({ password: PASSWORD });
    const events = listener();

    await manager.create(
      's1',
      {
        host: server.host,
        port: server.port,
        storedFingerprint: server.fingerprint(),
        username: 'deploy',
        authMethod: 'password',
        password: PASSWORD,
      },
      events,
    );
    manager.write('s1', 'echo hi\r');

    await waitFor(() => events.data.join('').includes('echo hi'));
    expect(events.data.join('')).toContain('fake shell ready');
  });

  it('logs in with a private key file', async () => {
    const key = generateClientKey();
    server = await startFakeSshServer({ authorizedKey: key.publicKey });
    const keyPath = join(tempDir(), 'id_ed25519');
    writeFileSync(keyPath, key.privateKey);
    const events = listener();

    await manager.create(
      's1',
      {
        host: server.host,
        port: server.port,
        storedFingerprint: server.fingerprint(),
        username: 'deploy',
        authMethod: 'privateKey',
        privateKeyPath: keyPath,
      },
      events,
    );

    await waitFor(() => events.data.join('').includes('fake shell ready'));
  });

  it('refuses a server with no trusted key before sending the login', async () => {
    server = await startFakeSshServer({ password: PASSWORD });

    const failure = await manager
      .create(
        's1',
        {
          host: server.host,
          port: server.port,
          username: 'deploy',
          authMethod: 'password',
          password: PASSWORD,
        },
        listener(),
      )
      .catch((error: unknown) => error);

    expect(sshErrorCode(failure)).toBe('host-key-unknown');
    expect(failure).toMatchObject({ presented: server.fingerprint() });
    expect(server.authAttempts).toEqual([]);
    expect(server.shells).toHaveLength(0);
  });

  it('connects silently when the stored fingerprint matches', async () => {
    server = await startFakeSshServer({ password: PASSWORD });
    const events = listener();

    await manager.create(
      's1',
      {
        host: server.host,
        port: server.port,
        username: 'deploy',
        authMethod: 'password',
        password: PASSWORD,
        storedFingerprint: server.fingerprint(),
      },
      events,
    );

    await waitFor(() => events.data.join('').includes('fake shell ready'));
  });

  it('refuses a server whose host key changed', async () => {
    server = await startFakeSshServer({ password: PASSWORD });
    const stored = server.fingerprint();
    await server.rotateHostKey();

    await expect(
      manager.create(
        's1',
        {
          host: server.host,
          port: server.port,
          username: 'deploy',
          authMethod: 'password',
          password: PASSWORD,
          storedFingerprint: stored,
        },
        listener(),
      ),
    ).rejects.toThrow(/has changed since you last connected/);
  });

  it('explains a rejected login in plain words', async () => {
    server = await startFakeSshServer({ password: PASSWORD });

    await expect(
      manager.create(
        's1',
        {
          host: server.host,
          port: server.port,
          storedFingerprint: server.fingerprint(),
          username: 'deploy',
          authMethod: 'password',
          password: 'wrong',
        },
        listener(),
      ),
    ).rejects.toThrow('Authentication failed. Check the username, password, or private key.');
  });

  it('explains a server that is not listening', async () => {
    server = await startFakeSshServer({ password: PASSWORD });
    const { port } = server;
    await server.close();
    server = null;

    await expect(
      manager.create(
        's1',
        { host: '127.0.0.1', port, username: 'deploy', authMethod: 'password', password: PASSWORD },
        listener(),
      ),
    ).rejects.toThrow(`Could not reach 127.0.0.1:${port}.`);
  });

  it('reports the end of the session when the remote shell closes', async () => {
    server = await startFakeSshServer({ password: PASSWORD });
    const events = listener();
    await manager.create(
      's1',
      {
        host: server.host,
        port: server.port,
        storedFingerprint: server.fingerprint(),
        username: 'deploy',
        authMethod: 'password',
        password: PASSWORD,
      },
      events,
    );

    await waitFor(() => (server?.shells.length ?? 0) > 0);
    server.shells[0].exit(0);
    server.shells[0].end();

    await waitFor(() => events.exits.length === 1);
  });

  it('ignores a second create for a session that is already open', async () => {
    server = await startFakeSshServer({ password: PASSWORD });
    const events = listener();
    const options = {
      host: server.host,
      port: server.port,
      storedFingerprint: server.fingerprint(),
      username: 'deploy',
      authMethod: 'password' as const,
      password: PASSWORD,
    };

    await manager.create('s1', options, events);
    await manager.create('s1', options, events);

    expect(server.shells).toHaveLength(1);
  });

  it('types the initial input once the shell is open, and only once', async () => {
    server = await startFakeSshServer({ password: PASSWORD });
    const events = listener();
    const options = {
      host: server.host,
      port: server.port,
      storedFingerprint: server.fingerprint(),
      username: 'deploy',
      authMethod: 'password' as const,
      password: PASSWORD,
      initialInput: 'claude --resume abc-12345\r',
    };

    await manager.create('s1', options, events);
    await waitFor(() => events.data.join('').includes('claude --resume abc-12345'));
    // A second create for the same tab (a remount) must not type the command again.
    await manager.create('s1', options, events);
    manager.write('s1', 'done\r');
    await waitFor(() => events.data.join('').includes('done'));

    expect(events.data.join('').split('claude --resume abc-12345')).toHaveLength(2);
  });
});
