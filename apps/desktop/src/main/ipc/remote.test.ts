import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountStatus } from '../../shared/accountTypes';
import { IPC } from '../../shared/ipcChannels';
import { REMOTE_SIGN_IN_ERROR } from '../../shared/remoteAccess';
import { encodePairingCode, REMOTE_PROTOCOL_VERSION } from '../../shared/remoteProtocol';
import { invoke, loadIpc, useTempUserData } from '../../test/main/ipcHarness';

/** LAN hosting and connecting need a Runova sign-in, whichever screen or script asks for them. */

const manager = vi.hoisted(() => ({
  getState: vi.fn(() => ({ hosting: false })),
  startHost: vi.fn(() => ({ hosting: true })),
  stopHost: vi.fn(),
  connect: vi.fn(),
  connectSaved: vi.fn(async () => ({ ok: true })),
  generatePairingCode: vi.fn(),
  listSavedServers: vi.fn(() => [{ id: 'srv-1' }]),
  renameSavedServer: vi.fn(),
  removeSavedServer: vi.fn(),
  openSessionWindow: vi.fn(),
  sendClipboard: vi.fn(),
  sendFile: vi.fn(),
  fmRoots: vi.fn(),
  fmList: vi.fn(),
  fmMkdir: vi.fn(),
  fmDelete: vi.fn(),
  fmRename: vi.fn(),
  uploadFileTo: vi.fn(),
  downloadFile: vi.fn(),
}));
const account = vi.hoisted(() => ({ status: vi.fn() }));

vi.mock('../remote/manager', () => ({ remoteManager: manager }));
vi.mock('../account/live', () => ({ getAccountRuntime: () => account }));

useTempUserData();

const SIGNED_IN: AccountStatus = {
  state: 'signed-in',
  deviceId: 'd',
  sessionId: 1,
  account: { id: 1, email: 'sam@example.com', displayName: 'Sam' },
  rememberedOnDisk: true,
  needsSignIn: false,
};
const SIGNED_OUT: AccountStatus = { state: 'signed-out', deviceId: 'd' };
const code = encodePairingCode({
  v: REMOTE_PROTOCOL_VERSION,
  ip: '192.168.1.20',
  port: 7900,
  token: 't',
  deviceName: 'Desk',
});

beforeEach(async () => {
  vi.clearAllMocks();
  await loadIpc(
    () => import('./remote'),
    (module) => module.registerRemoteHandlers(),
  );
});

const SIGNED_IN_ONLY: [keyof typeof manager, string, unknown[]][] = [
  ['generatePairingCode', IPC.remote.generatePairingCode, []],
  ['renameSavedServer', IPC.remote.renameSavedServer, ['srv-1', 'Desk']],
  ['removeSavedServer', IPC.remote.removeSavedServer, ['srv-1']],
  ['openSessionWindow', IPC.remote.openSessionWindow, []],
  ['sendClipboard', IPC.remote.sendClipboard, []],
  ['sendFile', IPC.remote.sendFile, []],
  ['fmRoots', IPC.remote.fmRoots, []],
  ['fmList', IPC.remote.fmList, ['/']],
  ['fmMkdir', IPC.remote.fmMkdir, ['/', 'new']],
  ['fmDelete', IPC.remote.fmDelete, ['/a']],
  ['fmRename', IPC.remote.fmRename, ['/a', '/b']],
  ['uploadFileTo', IPC.remote.fmUploadTo, ['/']],
  ['downloadFile', IPC.remote.fmDownload, ['/a']],
];

describe('remote handlers signed out', () => {
  beforeEach(() => account.status.mockResolvedValue(SIGNED_OUT));

  it('will not start hosting', async () => {
    await expect(invoke(IPC.remote.startHost, { ip: '0.0.0.0', port: 7900 })).rejects.toThrow(
      REMOTE_SIGN_IN_ERROR,
    );
    expect(manager.startHost).not.toHaveBeenCalled();
  });

  it.each([
    ['connect', IPC.remote.connect, code],
    ['connectFiles', IPC.remote.connectFiles, code],
    ['connectSaved', IPC.remote.connectSaved, 'srv-1'],
    ['connectSavedFiles', IPC.remote.connectSavedFiles, 'srv-1'],
  ])('will not %s', async (_name, channel, argument) => {
    await expect(invoke(channel, argument)).resolves.toEqual({
      ok: false,
      error: REMOTE_SIGN_IN_ERROR,
    });
    expect(manager.connect).not.toHaveBeenCalled();
    expect(manager.connectSaved).not.toHaveBeenCalled();
  });

  it.each(SIGNED_IN_ONLY)('will not run %s', async (method, channel, args) => {
    await expect(invoke(channel, ...args)).rejects.toThrow(REMOTE_SIGN_IN_ERROR);
    expect(manager[method]).not.toHaveBeenCalled();
  });

  it('lists no saved computers', async () => {
    await expect(invoke(IPC.remote.listSavedServers)).resolves.toEqual([]);
    expect(manager.listSavedServers).not.toHaveBeenCalled();
  });

  it('still lets hosting be stopped and the state be read', async () => {
    await invoke(IPC.remote.stopHost);
    await invoke(IPC.remote.getState);

    expect(manager.stopHost).toHaveBeenCalled();
    expect(manager.getState).toHaveBeenCalled();
  });
});

describe('remote handlers signed in', () => {
  beforeEach(() => account.status.mockResolvedValue(SIGNED_IN));

  it('hosts', async () => {
    await invoke(IPC.remote.startHost, { ip: '192.168.1.20', port: 7900 });

    expect(manager.startHost).toHaveBeenCalledWith('192.168.1.20', 7900);
  });

  it.each(SIGNED_IN_ONLY)('runs %s', async (method, channel, args) => {
    await invoke(channel, ...args);

    expect(manager[method]).toHaveBeenCalledWith(...args);
  });

  it('lists saved computers', async () => {
    await expect(invoke(IPC.remote.listSavedServers)).resolves.toEqual([{ id: 'srv-1' }]);
  });

  it('connects by code and from a saved server', async () => {
    await expect(invoke(IPC.remote.connect, code)).resolves.toEqual({ ok: true });
    await invoke(IPC.remote.connectSaved, 'srv-1');

    expect(manager.connect).toHaveBeenCalledOnce();
    expect(manager.connectSaved).toHaveBeenCalledWith('srv-1', undefined);
  });
});
