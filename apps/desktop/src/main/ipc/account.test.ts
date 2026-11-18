import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { fakeWebContents } from '../../test/main/electronMock';
import { invoke, invokeFrom, loadIpc, useTempUserData } from '../../test/main/ipcHarness';

/** The QR code that lets the Runova app on a phone in. */

const account = vi.hoisted(() => ({ api: vi.fn(), status: vi.fn() }));

vi.mock('../notifications/forward', () => ({ refreshNotificationForwarding: vi.fn() }));
vi.mock('../mainWindow', () => ({ getMainWindow: () => null }));

useTempUserData();

describe('QR sign-in channels', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await loadIpc(
      () => import('./account'),
      (module) => module.registerAccountHandlers(() => account as never),
    );
  });

  it('turns the code into a picture and never hands its text to the page', async () => {
    const qrText = 'rq1.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
    account.api.mockResolvedValue({ id: 7, qrText, expiresAt: '2026-11-09T12:00:00Z' });

    const code = (await invoke(IPC.account.qrSignIn)) as Record<string, unknown>;

    expect(account.api).toHaveBeenCalledWith('POST', '/qr-sign-ins');
    expect(code.id).toBe(7);
    expect(code.expiresAt).toBe('2026-11-09T12:00:00Z');
    expect(code.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(code).not.toHaveProperty('qrText');
  });

  it('reads and answers a code by its id', async () => {
    account.api.mockResolvedValue({ status: 'scanned', matchCode: '0420' });

    await invoke(IPC.account.qrSignInStatus, { id: 7 });
    await invoke(IPC.account.qrSignInDecide, { id: 7, approve: true });

    expect(account.api).toHaveBeenCalledWith('GET', '/qr-sign-ins/7');
    expect(account.api).toHaveBeenCalledWith('POST', '/qr-sign-ins/7/decisions', { approve: true });
  });

  it('refuses an id that is not a number', async () => {
    await expect(invoke(IPC.account.qrSignInStatus, { id: '../sessions' })).rejects.toThrow(
      'not valid',
    );
    expect(account.api).not.toHaveBeenCalled();
  });
});

describe('sync key channels with a recovery phrase (E107)', () => {
  const runtime = {
    setKey: vi.fn(),
    rotateKey: vi.fn(),
    changePassphrase: vi.fn(),
    unlock: vi.fn(),
  };
  const WORDS =
    'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';
  let sender: ReturnType<typeof fakeWebContents>;
  let registry: typeof import('../phrase')['phraseRegistry'];

  beforeEach(async () => {
    vi.clearAllMocks();
    sender = fakeWebContents();
    await loadIpc(
      () => import('./account'),
      (module) => module.registerAccountHandlers(() => ({ ...account, ...runtime }) as never),
    );
    registry = (await import('../phrase')).phraseRegistry;
    runtime.setKey.mockResolvedValue({ recoveryKey: WORDS });
    runtime.rotateKey.mockResolvedValue({ recoveryKey: WORDS });
  });

  it('sets the key with the phrase behind an id, and keeps it for a retry after a failure', async () => {
    const made = registry.create({ purpose: 'sync', label: 'Personal', owner: sender.id });
    runtime.setKey.mockRejectedValueOnce(new Error('offline'));

    await expect(
      invokeFrom(sender, IPC.sync.setKey, { scopeId: 3, phraseId: made.id }),
    ).rejects.toThrow('offline');
    await invokeFrom(sender, IPC.sync.setKey, { scopeId: 3, phraseId: made.id });

    expect(runtime.setKey).toHaveBeenLastCalledWith(3, made.words.join(' '));
  });

  it('hands the new recovery key back as words with an id, for copy, save and the QR code', async () => {
    const result = await invokeFrom<{ recovery: { id: string; words: string[] } }>(
      sender,
      IPC.sync.setKey,
      { scopeId: 3, label: 'Personal', passphrase: 'a long and careful passphrase' },
    );

    expect(result.recovery.words.join(' ')).toBe(WORDS);
    expect(registry.peek(result.recovery.id, sender.id)).toMatchObject({
      purpose: 'sync-recovery',
      label: 'Personal',
      phrase: WORDS,
    });
    expect(result).not.toHaveProperty('recoveryKey');
  });

  it('changes and rotates with a phrase too', async () => {
    const one = registry.create({ purpose: 'sync', label: 'Team', owner: sender.id });
    const two = registry.create({ purpose: 'sync', label: 'Team', owner: sender.id });

    await invokeFrom(sender, IPC.sync.changePassphrase, { scopeId: 4, phraseId: one.id });
    await invokeFrom(sender, IPC.sync.rotateKey, { scopeId: 4, phraseId: two.id });

    expect(runtime.changePassphrase).toHaveBeenCalledWith(4, one.words.join(' '));
    expect(runtime.rotateKey).toHaveBeenCalledWith(4, two.words.join(' '));
  });

  it('refuses a phrase another window made, or both secrets at once', async () => {
    const made = registry.create({ purpose: 'sync', label: 'Personal', owner: sender.id + 1000 });

    await expect(
      invokeFrom(sender, IPC.sync.setKey, { scopeId: 3, phraseId: made.id }),
    ).rejects.toThrow(/no longer there/);
    await expect(
      invokeFrom(sender, IPC.sync.setKey, {
        scopeId: 3,
        phraseId: made.id,
        passphrase: 'x'.repeat(20),
      }),
    ).rejects.toThrow('not valid');
    expect(runtime.setKey).not.toHaveBeenCalled();
  });
});
