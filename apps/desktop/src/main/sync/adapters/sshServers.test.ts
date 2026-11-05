import { describe, expect, it } from 'vitest';
import type { StoredSshServer } from '../../../shared/apiTypes';
import { memorySecrets, sealed } from '../testing/memorySecrets';
import { sshServersAdapter } from './sshServers';

function server(overrides: Partial<StoredSshServer> = {}): StoredSshServer {
  return {
    id: 's1',
    nickname: 'Prod',
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    authMethod: 'privateKey',
    privateKeyPath: 'C:\\Users\\me\\.ssh\\id_ed25519',
    hostKeyFingerprint: 'SHA256:abc',
    createdAt: 1,
    lastConnectedAt: 5,
    secretEnvelope: sealed('passphrase'),
    ...overrides,
  };
}

function memoryStore(initial: StoredSshServer[] = []) {
  let servers = structuredClone(initial);
  return {
    getSshServers: async () => structuredClone(servers),
    setSshServers: async (next: StoredSshServer[]) => {
      servers = structuredClone(next);
    },
    get: () => servers,
  };
}

describe('sshServersAdapter', () => {
  it('lists a server with its secret opened and its host key pin', async () => {
    const [item] = await sshServersAdapter(memoryStore([server()]), memorySecrets()).list();

    expect(item?.value.secretEnvelope).toEqual({ $secret: 'passphrase' });
    expect(item?.value.hostKeyFingerprint).toBe('SHA256:abc');
  });

  it('adds a server from another computer with its secret sealed here and no key file yet', async () => {
    const store = memoryStore();

    await sshServersAdapter(store, memorySecrets()).apply({
      id: 's1',
      teamId: null,
      value: {
        id: 's1',
        nickname: 'Prod',
        host: 'prod.example.com',
        port: 22,
        username: 'deploy',
        authMethod: 'privateKey',
        hostKeyFingerprint: 'SHA256:abc',
        createdAt: 1,
        secretEnvelope: { $secret: 'passphrase' },
      },
    });

    const stored = store.get()[0];
    expect(stored?.secretEnvelope).toEqual(sealed('passphrase'));
    expect(stored?.lastConnectedAt).toBeNull();
    expect(stored).not.toHaveProperty('privateKeyPath');
  });

  it('keeps this computer’s key file and last connection on an update', async () => {
    const store = memoryStore([server()]);

    await sshServersAdapter(store, memorySecrets()).apply({
      id: 's1',
      teamId: null,
      value: { ...server(), nickname: 'Production', privateKeyPath: undefined, lastConnectedAt: 9 },
    });

    expect(store.get()[0]).toMatchObject({
      nickname: 'Production',
      privateKeyPath: 'C:\\Users\\me\\.ssh\\id_ed25519',
      lastConnectedAt: 5,
    });
  });

  it('drops the host key pin when another computer points the server at a new host or port', async () => {
    const store = memoryStore([server()]);
    const adapter = sshServersAdapter(store, memorySecrets());

    await adapter.apply({
      id: 's1',
      teamId: null,
      value: { ...server(), host: 'other.example.com', hostKeyFingerprint: 'SHA256:theirs' },
    });

    expect(store.get()[0]?.host).toBe('other.example.com');
    expect(store.get()[0]).not.toHaveProperty('hostKeyFingerprint');
  });

  it('keeps the pin that came with an update that leaves the host alone', async () => {
    const store = memoryStore([server()]);

    await sshServersAdapter(store, memorySecrets()).apply({
      id: 's1',
      teamId: null,
      value: { ...server(), hostKeyFingerprint: 'SHA256:new' },
    });

    expect(store.get()[0]?.hostKeyFingerprint).toBe('SHA256:new');
  });

  it('waits while the Servers passkey is locked', () => {
    let unlocked = false;
    const adapter = sshServersAdapter(memoryStore(), memorySecrets(), () => unlocked);

    expect(adapter.ready?.()).toBe(false);
    unlocked = true;
    expect(adapter.ready?.()).toBe(true);
  });

  it('names a kept copy so it can be told apart', () => {
    const adapter = sshServersAdapter(memoryStore(), memorySecrets());

    expect(adapter.duplicate?.({ nickname: 'Prod' }).nickname).toBe('Prod (from another computer)');
  });
});
