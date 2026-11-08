import { describe, expect, it } from 'vitest';
import { type AnywhereStoreIo, createAnywhereStore, DEFAULT_ANYWHERE_SETTINGS } from './settings';

function memoryIo(options: { canSeal?: boolean } = {}) {
  let file: unknown = null;
  const io: AnywhereStoreIo & { file: () => unknown; setFile: (value: unknown) => void } = {
    read: async () => (file === null ? null : JSON.parse(JSON.stringify(file))),
    write: async (value) => {
      file = JSON.parse(JSON.stringify(value));
    },
    canSeal: () => options.canSeal ?? true,
    seal: (plain) => `sealed:${Buffer.from(plain).toString('base64')}`,
    open: (sealed) => Buffer.from(sealed.replace(/^sealed:/, ''), 'base64').toString(),
    file: () => file,
    setFile: (value) => {
      file = value;
    },
  };
  return io;
}

describe('anywhere settings', () => {
  it('starts with nothing reachable', async () => {
    const store = createAnywhereStore(memoryIo());

    const settings = await store.settings();

    expect(settings).toEqual(DEFAULT_ANYWHERE_SETTINGS);
    expect(settings.allowOwnDevices).toBe(false);
    expect(settings.teamIds).toEqual([]);
    expect(settings.alwaysAllow).toEqual([]);
    expect(settings.defaultPermissions.files).toBe(false);
  });

  it('keeps a change and only that change', async () => {
    const io = memoryIo();
    const store = createAnywhereStore(io);

    await store.updateSettings({ allowOwnDevices: true, teamIds: [2] });
    const reloaded = await createAnywhereStore(io).settings();

    expect(reloaded).toEqual({ ...DEFAULT_ANYWHERE_SETTINGS, allowOwnDevices: true, teamIds: [2] });
  });

  it('drops values of the wrong shape from a hand-edited file', async () => {
    const io = memoryIo();
    io.setFile({
      version: 1,
      settings: { allowOwnDevices: 'yes', teamIds: ['x', 3], alwaysRelay: true },
    });

    const settings = await createAnywhereStore(io).settings();

    expect(settings.allowOwnDevices).toBe(false);
    expect(settings.teamIds).toEqual([3]);
    expect(settings.alwaysRelay).toBe(true);
  });
});

describe('anywhere identity', () => {
  it('makes one identity key, keeps it sealed, and gives the same one back', async () => {
    const io = memoryIo();
    const first = await createAnywhereStore(io).identity();
    const second = await createAnywhereStore(io).identity();

    expect(second.publicKey).toEqual(first.publicKey);
    expect(JSON.stringify(io.file())).not.toContain(
      Buffer.from(first.secretKey).toString('base64'),
    );
    expect((io.file() as { identity: string }).identity).toMatch(/^sealed:/);
  });

  it('keeps the key in memory only when the OS can not seal it', async () => {
    const io = memoryIo({ canSeal: false });
    const store = createAnywhereStore(io);

    const first = await store.identity();

    expect((await store.identity()).publicKey).toEqual(first.publicKey);
    expect((io.file() as { identity?: string } | null)?.identity).toBeUndefined();
    expect(store.remembersIdentity()).toBe(false);
  });
});

describe('anywhere password secret', () => {
  it('keeps the derived secret sealed, for the host key it was made for', async () => {
    const io = memoryIo();
    const store = createAnywhereStore(io);
    const secret = new Uint8Array(32).fill(7);

    await store.setPasswordSecret(secret, 'host-key-a');

    expect(await createAnywhereStore(io).passwordSecret('host-key-a')).toEqual(secret);
    expect(await createAnywhereStore(io).passwordSecret('host-key-b')).toBeNull();
    expect(await store.hasPasswordSecret()).toBe(true);
    expect(JSON.stringify(io.file())).not.toContain(Buffer.from(secret).toString('base64'));
  });

  it('refuses to keep a password secret it can not seal', async () => {
    const store = createAnywhereStore(memoryIo({ canSeal: false }));

    await expect(store.setPasswordSecret(new Uint8Array(32), 'k')).rejects.toThrow(/keychain/i);
  });

  it('forgets the secret when the password is removed', async () => {
    const store = createAnywhereStore(memoryIo());
    await store.setPasswordSecret(new Uint8Array(32).fill(1), 'k');

    await store.setPasswordSecret(null, 'k');

    expect(await store.hasPasswordSecret()).toBe(false);
    expect(await store.passwordSecret('k')).toBeNull();
  });
});

describe('anywhere pins and recent connections', () => {
  it('pins a host key per Runova ID', async () => {
    const io = memoryIo();
    const store = createAnywhereStore(io);

    expect(await store.pin('482193775')).toBeNull();
    await store.setPin('482193775', 'key-1');

    expect(await createAnywhereStore(io).pin('482193775')).toBe('key-1');
  });

  it('keeps the 10 newest connections, newest first, one entry per ID', async () => {
    const store = createAnywhereStore(memoryIo());
    for (let i = 0; i < 14; i++) {
      await store.addRecent({
        remoteId: `10000000${i % 10}`,
        name: `PC ${i}`,
        platform: 'windows',
        at: i,
      });
    }

    const recent = await store.recent();

    expect(recent).toHaveLength(10);
    expect(recent[0]).toEqual({
      remoteId: '100000003',
      name: 'PC 13',
      platform: 'windows',
      at: 13,
    });
    expect(new Set(recent.map((r) => r.remoteId)).size).toBe(10);
  });

  it('can forget a recent connection', async () => {
    const store = createAnywhereStore(memoryIo());
    await store.addRecent({ remoteId: '100000001', name: 'A', platform: 'linux', at: 1 });

    await store.forgetRecent('100000001');

    expect(await store.recent()).toEqual([]);
  });
});
