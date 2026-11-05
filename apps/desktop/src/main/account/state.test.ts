import { describe, expect, it } from 'vitest';
import { type AccountStatePort, createAccountState } from './state';

function memoryPort(options: { sealing?: boolean } = {}) {
  const port: AccountStatePort & { file: unknown } = {
    file: null,
    read: async () => port.file,
    write: async (value) => {
      port.file = JSON.parse(JSON.stringify(value));
    },
    canSeal: () => options.sealing !== false,
    seal: (plain) => `sealed:${Buffer.from(plain).toString('base64')}`,
    open: (sealed) => {
      if (!sealed.startsWith('sealed:')) throw new Error('not sealed');
      return Buffer.from(sealed.slice(7), 'base64').toString();
    },
  };
  return port;
}

const ACCOUNT = { id: 42, email: 'sam@example.com', displayName: 'Sam' };

describe('account state', () => {
  it('starts signed out with a device id of its own that stays', async () => {
    const port = memoryPort();
    const first = createAccountState(port);
    const deviceId = (await first.snapshot()).deviceId;

    const again = createAccountState(port);

    expect((await first.snapshot()).account).toBeNull();
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await again.snapshot()).deviceId).toBe(deviceId);
  });

  it('keeps the refresh token sealed on disk and gives it back opened', async () => {
    const port = memoryPort();
    const state = createAccountState(port);

    await state.signedIn({ account: ACCOUNT, sessionId: 9, refreshToken: 'rt-secret' });

    expect(JSON.stringify(port.file)).not.toContain('rt-secret');
    expect(await createAccountState(port).refreshToken()).toBe('rt-secret');
    expect((await state.snapshot()).account).toEqual(ACCOUNT);
  });

  it('keeps the token in memory only when there is no keychain', async () => {
    const port = memoryPort({ sealing: false });
    const state = createAccountState(port);

    await state.signedIn({ account: ACCOUNT, sessionId: 9, refreshToken: 'rt-secret' });

    expect(JSON.stringify(port.file)).not.toContain('rt-secret');
    expect(await state.refreshToken()).toBe('rt-secret');
    expect(await createAccountState(port).refreshToken()).toBeNull();
    expect((await state.snapshot()).rememberedOnDisk).toBe(false);
  });

  it('stores scope keys sealed and hands them back as buffers', async () => {
    const port = memoryPort();
    const state = createAccountState(port);
    await state.signedIn({ account: ACCOUNT, sessionId: 9, refreshToken: 'rt' });

    await state.putKey(7, 2, Buffer.alloc(32, 5));

    expect(JSON.stringify(port.file)).not.toContain(Buffer.alloc(32, 5).toString('base64'));
    const key = await createAccountState(port).key(7);
    expect(key?.version).toBe(2);
    expect(key?.key.equals(Buffer.alloc(32, 5))).toBe(true);
  });

  it('forgets the token, the keys and the account on sign-out, but not the device id', async () => {
    const port = memoryPort();
    const state = createAccountState(port);
    await state.signedIn({ account: ACCOUNT, sessionId: 9, refreshToken: 'rt' });
    await state.putKey(7, 1, Buffer.alloc(32, 5));
    const deviceId = (await state.snapshot()).deviceId;

    await state.signedOut();

    const after = createAccountState(port);
    expect(await after.refreshToken()).toBeNull();
    expect(await after.key(7)).toBeNull();
    expect((await after.snapshot()).account).toBeNull();
    expect((await after.snapshot()).deviceId).toBe(deviceId);
  });

  it('drops a file it can not read rather than trusting it', async () => {
    const port = memoryPort();
    port.file = { version: 1, account: { id: 'not a number' }, refreshToken: 5 };

    const state = createAccountState(port);

    expect((await state.snapshot()).account).toBeNull();
    expect(await state.refreshToken()).toBeNull();
  });

  it('drops a token it can not open (another computer’s keychain)', async () => {
    const port = memoryPort();
    const state = createAccountState(port);
    await state.signedIn({ account: ACCOUNT, sessionId: 9, refreshToken: 'rt' });
    (port.file as { refreshToken: string }).refreshToken = 'garbage';

    expect(await createAccountState(port).refreshToken()).toBeNull();
  });

  it('replaces the refresh token on rotation', async () => {
    const port = memoryPort();
    const state = createAccountState(port);
    await state.signedIn({ account: ACCOUNT, sessionId: 9, refreshToken: 'rt-1' });

    await state.rotated('rt-2');

    expect(await createAccountState(port).refreshToken()).toBe('rt-2');
  });
});
