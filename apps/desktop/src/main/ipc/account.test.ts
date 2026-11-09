import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { invoke, loadIpc, useTempUserData } from '../../test/main/ipcHarness';

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
