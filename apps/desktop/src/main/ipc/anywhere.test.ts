import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountStatus } from '../../shared/accountTypes';
import { IPC } from '../../shared/ipcChannels';
import { REMOTE_SIGN_IN_ERROR } from '../../shared/remoteAccess';
import { invoke, loadIpc, useTempUserData } from '../../test/main/ipcHarness';

/** Runova Anywhere needs a Runova sign-in, whichever screen or script asks for it. */

const service = vi.hoisted(() => ({
  connect: vi.fn(),
  submitPassword: vi.fn(),
  trustNewKey: vi.fn(),
  respondIncoming: vi.fn(),
  updateSettings: vi.fn(),
  setPassword: vi.fn(),
  history: vi.fn(),
  deleteHistory: vi.fn(),
  forgetPhone: vi.fn(),
  setPhoneScopes: vi.fn(),
  forgetRecent: vi.fn(),
  forgetSavedPassword: vi.fn(),
  enableAgent: vi.fn(),
  disableAgent: vi.fn(),
  disconnect: vi.fn(),
  endHosted: vi.fn(),
}));
const account = vi.hoisted(() => ({ status: vi.fn() }));

vi.mock('../remote/anywhere/live', () => ({
  getAnywhere: () => service,
  anywhereState: () => null,
  anywhereLinks: () => null,
}));
vi.mock('../account/live', () => ({ getAccountRuntime: () => account }));
vi.mock('../mainWindow', () => ({ getMainWindow: () => null }));

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
const NEEDS_SIGN_IN: AccountStatus = { ...SIGNED_IN, needsSignIn: true };

const SIGNED_IN_ONLY: [keyof typeof service, string, unknown[]][] = [
  ['connect', IPC.anywhere.connect, [{ remoteId: '123456789', intent: 'control' }]],
  ['submitPassword', IPC.anywhere.submitPassword, ['pw', false]],
  ['trustNewKey', IPC.anywhere.trustNewKey, []],
  ['respondIncoming', IPC.anywhere.respondIncoming, ['s1', { accept: true }]],
  ['updateSettings', IPC.anywhere.updateSettings, [{ teamIds: [] }]],
  ['setPassword', IPC.anywhere.setPassword, ['pw']],
  ['history', IPC.anywhere.history, []],
  ['deleteHistory', IPC.anywhere.deleteHistory, [1]],
  ['forgetPhone', IPC.anywhere.forgetPhone, ['key-1']],
  ['setPhoneScopes', IPC.anywhere.setPhoneScopes, ['key-1', ['git']]],
  ['forgetRecent', IPC.anywhere.forgetRecent, ['123456789']],
  ['forgetSavedPassword', IPC.anywhere.forgetSavedPassword, ['123456789']],
  ['enableAgent', IPC.anywhere.enableAgent, ['pw']],
  ['disableAgent', IPC.anywhere.disableAgent, []],
];

beforeEach(async () => {
  vi.clearAllMocks();
  await loadIpc(
    () => import('./anywhere'),
    (module) => module.registerAnywhereHandlers(),
  );
});

describe.each([
  ['signed out', SIGNED_OUT],
  ['told to sign in again', NEEDS_SIGN_IN],
])('Anywhere handlers %s', (_name, status) => {
  beforeEach(() => account.status.mockResolvedValue(status));

  it.each(SIGNED_IN_ONLY)('will not run %s', async (method, channel, args) => {
    await expect(invoke(channel, ...args)).rejects.toThrow(REMOTE_SIGN_IN_ERROR);
    expect(service[method]).not.toHaveBeenCalled();
  });

  it('still lets a session be ended', async () => {
    await invoke(IPC.anywhere.disconnect);
    await invoke(IPC.anywhere.endHosted, 's1');

    expect(service.disconnect).toHaveBeenCalled();
    expect(service.endHosted).toHaveBeenCalledWith('s1');
  });
});

describe('Anywhere handlers signed in', () => {
  beforeEach(() => account.status.mockResolvedValue(SIGNED_IN));

  it.each(SIGNED_IN_ONLY)('runs %s', async (method, channel, args) => {
    await invoke(channel, ...args);

    expect(service[method]).toHaveBeenCalledWith(...args);
  });
});
