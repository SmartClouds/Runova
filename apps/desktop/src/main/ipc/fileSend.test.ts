import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountStatus } from '../../shared/accountTypes';
import { EMPTY_FILE_SEND_STATE } from '../../shared/fileSend';
import { IPC } from '../../shared/ipcChannels';
import { REMOTE_SIGN_IN_ERROR } from '../../shared/remoteAccess';
import { queueDialog } from '../../test/main/electronMock';
import {
  electronState,
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/** Sending files needs a Runova sign-in, and never takes a path from a screen beyond staging it. */

const service = vi.hoisted(() => ({
  state: vi.fn(),
  stage: vi.fn(async (paths: string[]) => ({
    staged: paths.map((p) => ({ id: p })),
    problems: [],
  })),
  unstage: vi.fn(),
  send: vi.fn(async () => ({ batchId: 'b1' })),
  cancel: vi.fn(),
  cancelFile: vi.fn(),
  retry: vi.fn(async () => ({ batchId: 'b2' })),
  dismiss: vi.fn(),
  clearFinished: vi.fn(),
  respond: vi.fn(),
  updateSettings: vi.fn(),
  savedPathOf: vi.fn((_batchId: string, transferId?: string) =>
    transferId ? '/inbox/Holiday/beach.jpg' : '/inbox',
  ),
}));
const account = vi.hoisted(() => ({ status: vi.fn() }));
const live = vi.hoisted(() => ({ state: null as unknown }));

vi.mock('../remote/anywhere/live', () => ({
  getFileSend: () => service,
  fileSendState: () => live.state,
}));
vi.mock('../account/live', () => ({ getAccountRuntime: () => account }));
vi.mock('../mainWindow', () => ({ getMainWindow: () => null }));

useTempUserData();
expectChannelsCovered(IPC.fileSend, [IPC.fileSend.onState]);

const SIGNED_IN: AccountStatus = {
  state: 'signed-in',
  deviceId: 'd',
  sessionId: 1,
  account: { id: 1, email: 'sam@example.com', displayName: 'Sam' },
  rememberedOnDisk: true,
  needsSignIn: false,
};
const SIGNED_OUT: AccountStatus = { state: 'signed-out', deviceId: 'd' };

beforeEach(async () => {
  vi.clearAllMocks();
  live.state = null;
  await loadIpc(
    () => import('./fileSend'),
    (module) => module.registerFileSendHandlers(),
  );
});

describe('sending files signed out', () => {
  beforeEach(() => account.status.mockResolvedValue(SIGNED_OUT));

  it.each([
    [IPC.fileSend.stagePaths, [['/a.txt']]],
    [IPC.fileSend.pickFiles, []],
    [IPC.fileSend.pickFolder, []],
    [IPC.fileSend.send, [{ remoteId: '482193775' }]],
    [IPC.fileSend.retry, ['b1']],
    [IPC.fileSend.respond, ['b1', { accept: true }]],
    [IPC.fileSend.chooseFolder, ['b1']],
    [IPC.fileSend.chooseSaveFolder, []],
    [IPC.fileSend.updateSettings, [{ receiveFrom: 'own' }]],
  ])('will not run %s', async (channel, args) => {
    await expect(invoke(channel, ...args)).rejects.toThrow(REMOTE_SIGN_IN_ERROR);
    expect(service.stage).not.toHaveBeenCalled();
    expect(service.send).not.toHaveBeenCalled();
    expect(service.respond).not.toHaveBeenCalled();
  });

  it('still lets what is going be stopped, dismissed and opened', async () => {
    await invoke(IPC.fileSend.cancel, 'b1');
    await invoke(IPC.fileSend.cancelFile, 'b1', 't1');
    await invoke(IPC.fileSend.dismiss, 'b1');
    await invoke(IPC.fileSend.clearFinished);
    await invoke(IPC.fileSend.unstage, 'all');

    expect(service.cancel).toHaveBeenCalledWith('b1');
    expect(service.cancelFile).toHaveBeenCalledWith('b1', 't1');
    expect(service.dismiss).toHaveBeenCalledWith('b1');
    expect(service.clearFinished).toHaveBeenCalled();
    expect(service.unstage).toHaveBeenCalledWith('all');
  });

  it('answers with an empty state before anything has started', async () => {
    expect(await invoke(IPC.fileSend.getState)).toEqual(EMPTY_FILE_SEND_STATE);

    live.state = { ...EMPTY_FILE_SEND_STATE, available: true };
    expect(await invoke(IPC.fileSend.getState)).toMatchObject({ available: true });
  });
});

describe('sending files signed in', () => {
  beforeEach(() => account.status.mockResolvedValue(SIGNED_IN));

  it('stages only paths, and no more than a pick can hold', async () => {
    await invoke(IPC.fileSend.stagePaths, ['/a.txt', 7, '', '/b']);

    expect(service.stage).toHaveBeenCalledWith(['/a.txt', '/b']);
    await expect(invoke(IPC.fileSend.stagePaths, 'not a list')).rejects.toThrow();
  });

  it('stages what the person picks, and nothing when they cancel', async () => {
    queueDialog('showOpenDialog', { canceled: false, filePaths: ['/a.txt', '/b.txt'] });
    await invoke(IPC.fileSend.pickFiles);
    queueDialog('showOpenDialog', { canceled: false, filePaths: ['/Holiday'] });
    await invoke(IPC.fileSend.pickFolder);
    queueDialog('showOpenDialog', { canceled: true, filePaths: [] });
    await invoke(IPC.fileSend.pickFiles);

    expect(service.stage.mock.calls).toEqual([[['/a.txt', '/b.txt']], [['/Holiday']]]);
  });

  it('sends to a Runova ID, with the note cut to its limit', async () => {
    await invoke(IPC.fileSend.send, { remoteId: '482 193 775', note: `  ${'x'.repeat(600)}  ` });

    expect(service.send).toHaveBeenCalledWith({ remoteId: '482193775', note: 'x'.repeat(500) });
    await expect(invoke(IPC.fileSend.send, { remoteId: 'not an id' })).rejects.toThrow(/Runova ID/);
  });

  it('sends a failed batch again', async () => {
    expect(await invoke(IPC.fileSend.retry, 'b1')).toEqual({ batchId: 'b2' });
  });

  it('answers an offer with the folder the person picked for it, and nothing the screen said', async () => {
    queueDialog('showOpenDialog', { canceled: false, filePaths: ['/elsewhere'] });
    expect(await invoke(IPC.fileSend.chooseFolder, 'b1')).toBe('/elsewhere');

    await invoke(IPC.fileSend.respond, 'b1', {
      accept: true,
      folder: '/etc',
      alwaysAcceptOwn: true,
    });

    expect(service.respond).toHaveBeenCalledWith('b1', {
      accept: true,
      folder: '/elsewhere',
      alwaysAcceptOwn: true,
    });
  });

  it('keeps the usual folder when none was picked for the offer', async () => {
    await invoke(IPC.fileSend.respond, 'b9', { accept: false });

    expect(service.respond).toHaveBeenCalledWith('b9', { accept: false, alwaysAcceptOwn: false });
  });

  it('sets the save folder only through the folder picker', async () => {
    queueDialog('showOpenDialog', { canceled: false, filePaths: ['/inbox'] });
    expect(await invoke(IPC.fileSend.chooseSaveFolder)).toBe('/inbox');
    expect(service.updateSettings).toHaveBeenCalledWith({ saveFolder: '/inbox' });

    await invoke(IPC.fileSend.updateSettings, {
      receiveFrom: 'strangers',
      autoAcceptOwn: true,
      saveFolder: '/etc',
    });
    expect(service.updateSettings).toHaveBeenLastCalledWith({ autoAcceptOwn: true });

    await invoke(IPC.fileSend.updateSettings, { receiveFrom: 'own', saveFolder: null });
    expect(service.updateSettings).toHaveBeenLastCalledWith({
      receiveFrom: 'own',
      saveFolder: null,
    });
  });

  it('shows and opens received files by where main saved them', async () => {
    await invoke(IPC.fileSend.showInFolder, 'b1', 't1');
    await invoke(IPC.fileSend.showInFolder, 'b1');
    await invoke(IPC.fileSend.openFile, 'b1', 't1');

    expect(electronState.openedPaths).toEqual([
      '/inbox/Holiday/beach.jpg',
      '/inbox',
      '/inbox/Holiday/beach.jpg',
    ]);
  });

  it('opens the main window on the Send files tab', async () => {
    await expect(invoke(IPC.fileSend.openApp)).resolves.toBeUndefined();
  });
});
