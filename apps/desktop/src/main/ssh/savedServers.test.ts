import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StoredSshServer } from '../../shared/apiTypes';
import { useTempUserData } from '../../test/main/ipcHarness';

/**
 * Saved Remote servers as connection endpoints. Secrets are decrypted only here, in main, and
 * every write to ssh-servers.json goes through one queue so concurrent updates never lose each
 * other's changes.
 */

const userData = useTempUserData();

type Module = typeof import('./savedServers');
let saved: Module;
let vault: typeof import('./vault');

function server(overrides: Partial<StoredSshServer> = {}): StoredSshServer {
  return {
    id: 'srv-1',
    nickname: 'prod',
    host: 'prod.example',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    createdAt: 1,
    lastConnectedAt: null,
    ...overrides,
  };
}

function stored(): StoredSshServer[] {
  return JSON.parse(readFileSync(userData.dataFile('ssh-servers.json'), 'utf-8'));
}

beforeEach(async () => {
  saved = await import('./savedServers');
  vault = await import('./vault');
});

describe('savedServerEndpoint through the tunnel (E95)', () => {
  it('goes through Cloudflare Access with the sealed service token, keeping the login and host key', async () => {
    userData.writeData('ssh-servers.json', [
      server({
        secretEnvelope: await vault.encryptSecret('login pw'),
        hostKeyFingerprint: 'ab'.repeat(32),
        sshRoute: 'cloudflare',
        cloudflareTunnel: {
          hostname: 'ssh.example.com',
          clientId: 'id.access',
          clientSecret: await vault.encryptSecret('access secret'),
        },
      }),
    ]);

    expect(await saved.savedServerEndpoint('srv-1')).toMatchObject({
      host: 'prod.example',
      password: 'login pw',
      storedFingerprint: 'ab'.repeat(32),
      via: {
        kind: 'cloudflare',
        hostname: 'ssh.example.com',
        clientId: 'id.access',
        clientSecret: 'access secret',
      },
    });
  });

  it('goes to the Mesh address over Mesh, and straight to the host when no route is on', async () => {
    userData.writeData('ssh-servers.json', [
      server({ sshRoute: 'mesh', cloudflareTunnel: { meshAddress: '100.96.0.12' } }),
      server({ id: 'srv-2', cloudflareTunnel: { meshAddress: '100.96.0.13' } }),
    ]);

    expect((await saved.savedServerEndpoint('srv-1')).host).toBe('100.96.0.12');
    expect(await saved.savedServerEndpoint('srv-2')).not.toHaveProperty('via');
    expect((await saved.savedServerEndpoint('srv-2')).host).toBe('prod.example');
  });

  it('keeps nothing for a server that is not a saved SSH server', async () => {
    userData.writeData('ssh-servers.json', [server()]);

    expect(await saved.readTunnelSsh('devhost')).toEqual({});
  });

  it('sets and clears the route with what the app keeps about the tunnel', async () => {
    userData.writeData('ssh-servers.json', [server()]);

    await saved.updateTunnelSsh(
      'srv-1',
      (current) => ({ ...current, meshAddress: '100.96.0.12' }),
      'mesh',
    );
    const set = stored()[0];
    await saved.updateTunnelSsh('srv-1', () => undefined, null);
    const cleared = stored()[0];

    expect(set.sshRoute).toBe('mesh');
    expect(set.cloudflareTunnel).toEqual({ meshAddress: '100.96.0.12' });
    expect(cleared.sshRoute).toBeUndefined();
    expect(cleared.cloudflareTunnel).toBeUndefined();
  });
});

describe('routedServerEndpoint, a test connection over a route before it is on (E95)', () => {
  it('goes through the tunnel even while SSH still goes straight to the host', async () => {
    userData.writeData('ssh-servers.json', [
      server({
        cloudflareTunnel: {
          hostname: 'ssh.example.com',
          clientId: 'id.access',
          clientSecret: await vault.encryptSecret('access secret'),
          meshAddress: '100.96.0.12',
        },
      }),
    ]);

    expect(await saved.routedServerEndpoint('srv-1', 'cloudflare')).toMatchObject({
      host: 'prod.example',
      via: { kind: 'cloudflare', hostname: 'ssh.example.com', clientSecret: 'access secret' },
    });
    expect((await saved.routedServerEndpoint('srv-1', 'mesh')).host).toBe('100.96.0.12');
  });

  it('says what is missing when the tunnel has no SSH name or the server no Mesh address', async () => {
    userData.writeData('ssh-servers.json', [
      server({ cloudflareTunnel: { hostname: 'ssh.example.com' } }),
    ]);

    await expect(saved.routedServerEndpoint('srv-1', 'cloudflare')).rejects.toThrow(
      'SSH has no name on the tunnel yet. Route the tunnel first.',
    );
    await expect(saved.routedServerEndpoint('srv-1', 'mesh')).rejects.toThrow(
      'This server has no Mesh address yet. Add it to Mesh first.',
    );
  });

  it('refuses a server that was removed', async () => {
    userData.writeData('ssh-servers.json', [server()]);

    await expect(saved.routedServerEndpoint('srv-gone', 'mesh')).rejects.toThrow(
      'This saved server no longer exists.',
    );
  });
});

describe('reorderSshServers', () => {
  it('saves the servers in the dragged order and returns them', async () => {
    userData.writeData('ssh-servers.json', [
      server(),
      server({ id: 'srv-2', nickname: 'staging' }),
      server({ id: 'srv-3', nickname: 'dev' }),
    ]);

    const reordered = await saved.reorderSshServers(['srv-3', 'srv-1', 'srv-2']);

    expect(reordered.map((s) => s.id)).toEqual(['srv-3', 'srv-1', 'srv-2']);
    expect(stored().map((s) => s.id)).toEqual(['srv-3', 'srv-1', 'srv-2']);
  });

  it('keeps a connect that finishes mid-drop, since both writes share one queue', async () => {
    userData.writeData('ssh-servers.json', [server(), server({ id: 'srv-2' })]);

    await Promise.all([
      saved.updateSshServer('srv-1', (s) => ({ ...s, lastConnectedAt: 42 })),
      saved.reorderSshServers(['srv-2', 'srv-1']),
    ]);

    expect(stored().map((s) => [s.id, s.lastConnectedAt])).toEqual([
      ['srv-2', null],
      ['srv-1', 42],
    ]);
  });
});

describe('savedServerEndpoint', () => {
  it('decrypts a saved login password', async () => {
    userData.writeData('ssh-servers.json', [
      server({
        secretEnvelope: await vault.encryptSecret('login pw'),
        hostKeyFingerprint: 'ab'.repeat(32),
      }),
    ]);

    expect(await saved.savedServerEndpoint('srv-1')).toEqual({
      host: 'prod.example',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      password: 'login pw',
      privateKeyPath: undefined,
      passphrase: undefined,
      storedFingerprint: 'ab'.repeat(32),
    });
  });

  it('treats the secret of a key login as the key passphrase', async () => {
    userData.writeData('ssh-servers.json', [
      server({
        authMethod: 'privateKey',
        privateKeyPath: '/home/me/.ssh/id_ed25519',
        secretEnvelope: await vault.encryptSecret('key passphrase'),
      }),
    ]);

    const endpoint = await saved.savedServerEndpoint('srv-1');

    expect(endpoint.passphrase).toBe('key passphrase');
    expect(endpoint.password).toBeUndefined();
    expect(endpoint.privateKeyPath).toBe('/home/me/.ssh/id_ed25519');
  });

  it('refuses a server that was removed', async () => {
    userData.writeData('ssh-servers.json', [server()]);

    await expect(saved.savedServerEndpoint('srv-gone')).rejects.toThrow(
      'This saved server no longer exists.',
    );
  });
});

describe('savedServerPoolSource', () => {
  it('stores a key trusted on first use', async () => {
    userData.writeData('ssh-servers.json', [server()]);

    await saved.savedServerPoolSource.trustHostKey('srv-1', 'cd'.repeat(32));

    expect(stored()[0].hostKeyFingerprint).toBe('cd'.repeat(32));
  });

  it('never replaces a key that was already trusted', async () => {
    userData.writeData('ssh-servers.json', [server({ hostKeyFingerprint: 'ab'.repeat(32) })]);

    await saved.savedServerPoolSource.trustHostKey('srv-1', 'cd'.repeat(32));

    expect(stored()[0].hostKeyFingerprint).toBe('ab'.repeat(32));
  });

  it('records when the server was last connected to', async () => {
    userData.writeData('ssh-servers.json', [server()]);

    saved.savedServerPoolSource.connected?.('srv-1');
    await saved.updateSshServer('srv-1', (s) => s);

    expect(stored()[0].lastConnectedAt).toEqual(expect.any(Number));
  });
});

describe('updateSshServer', () => {
  it('applies concurrent updates one after another so none is lost', async () => {
    userData.writeData('ssh-servers.json', [server()]);

    await Promise.all([
      saved.updateSshServer('srv-1', (s) => ({ ...s, hostKeyFingerprint: 'ab'.repeat(32) })),
      saved.updateSshServer('srv-1', (s) => ({ ...s, lastConnectedAt: 42 })),
    ]);

    expect(stored()[0]).toMatchObject({ hostKeyFingerprint: 'ab'.repeat(32), lastConnectedAt: 42 });
  });

  it('ignores a server that is no longer saved', async () => {
    userData.writeData('ssh-servers.json', [server()]);

    await saved.updateSshServer('srv-gone', (s) => ({ ...s, nickname: 'changed' }));

    expect(stored()).toEqual([server()]);
  });
});
