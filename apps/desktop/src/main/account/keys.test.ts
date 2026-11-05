import { describe, expect, it } from 'vitest';
import type { KeyEnvelope } from './keyring';
import { createKeyService } from './keys';
import { type AccountStatePort, createAccountState } from './state';

const FAST = { N: 2 ** 10, r: 8, p: 1 };

function memoryState() {
  let file: unknown = null;
  const port: AccountStatePort = {
    read: async () => file,
    write: async (value) => {
      file = JSON.parse(JSON.stringify(value));
    },
    canSeal: () => true,
    seal: (plain) => `s:${plain}`,
    open: (sealed) => sealed.slice(2),
  };
  return createAccountState(port);
}

function memoryServer() {
  const keys = new Map<number, { version: number; envelope: KeyEnvelope }>();
  return {
    keys,
    api: {
      key: async (scopeId: number) => keys.get(scopeId) ?? null,
      putKey: async (scopeId: number, version: number, envelope: KeyEnvelope) => {
        const current = keys.get(scopeId)?.version ?? null;
        if (current === null ? version !== 1 : version !== current && version !== current + 1) {
          throw new Error('conflict');
        }
        keys.set(scopeId, { version, envelope });
      },
      resetKey: async (scopeId: number) => {
        keys.delete(scopeId);
      },
    },
  };
}

describe('key service', () => {
  it('sets a key, keeps it here, and gives a recovery key once', async () => {
    const server = memoryServer();
    const state = memoryState();
    const service = createKeyService({ api: server.api, state, cost: FAST });

    const { recoveryKey } = await service.setKey(1, 'correct horse battery staple');

    expect(recoveryKey).toMatch(/^([0-9A-Z]{7}-){7}[0-9A-Z]{7}$/);
    expect(server.keys.get(1)?.version).toBe(1);
    expect((await service.key(1))?.version).toBe(1);
    expect(JSON.stringify(server.keys.get(1))).not.toContain('correct horse');
  });

  it('refuses a weak passphrase before anything leaves this computer', async () => {
    const server = memoryServer();
    const service = createKeyService({ api: server.api, state: memoryState(), cost: FAST });

    await expect(service.setKey(1, 'short')).rejects.toThrow(/12 characters/);
    await expect(service.setKey(1, 'aaaaaaaaaaaaaaaa')).rejects.toThrow(/guess/);
    expect(server.keys.size).toBe(0);
  });

  it('unlocks on a second computer with the passphrase or the recovery key', async () => {
    const server = memoryServer();
    const first = createKeyService({ api: server.api, state: memoryState(), cost: FAST });
    const { recoveryKey } = await first.setKey(1, 'correct horse battery staple');
    const made = await first.key(1);

    const second = createKeyService({ api: server.api, state: memoryState(), cost: FAST });
    await expect(second.unlock(1, { passphrase: 'wrong but long enough' })).rejects.toThrow(
      /not right/,
    );
    expect(await second.key(1)).toBeNull();
    await second.unlock(1, { passphrase: 'correct horse battery staple' });
    expect((await second.key(1))?.key.equals(made?.key as Buffer)).toBe(true);

    const third = createKeyService({ api: server.api, state: memoryState(), cost: FAST });
    await third.unlock(1, { recoveryKey });
    expect((await third.key(1))?.key.equals(made?.key as Buffer)).toBe(true);
  });

  it('changes the passphrase without changing the key', async () => {
    const server = memoryServer();
    const service = createKeyService({ api: server.api, state: memoryState(), cost: FAST });
    await service.setKey(1, 'correct horse battery staple');
    const before = await service.key(1);

    await service.changePassphrase(1, 'a different long passphrase');

    const other = createKeyService({ api: server.api, state: memoryState(), cost: FAST });
    await other.unlock(1, { passphrase: 'a different long passphrase' });
    expect((await other.key(1))?.key.equals(before?.key as Buffer)).toBe(true);
    expect(server.keys.get(1)?.version).toBe(1);
  });

  it('rotates to a new key at the next version', async () => {
    const server = memoryServer();
    const service = createKeyService({ api: server.api, state: memoryState(), cost: FAST });
    await service.setKey(1, 'correct horse battery staple');
    const before = await service.key(1);

    await service.rotate(1, 'correct horse battery staple');

    const after = await service.key(1);
    expect(after?.version).toBe(2);
    expect(after?.key.equals(before?.key as Buffer)).toBe(false);
  });

  it('forgets a key that the server no longer has', async () => {
    const server = memoryServer();
    const service = createKeyService({ api: server.api, state: memoryState(), cost: FAST });
    await service.setKey(1, 'correct horse battery staple');

    await service.reset(1, { password: 'pw' });

    expect(await service.key(1)).toBeNull();
    expect(server.keys.has(1)).toBe(false);
  });
});
