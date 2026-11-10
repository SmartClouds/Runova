import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type { DeployBackups } from '../deploy/backups';
import type { DeployHardening } from '../deploy/hardening';
import type { DeployService } from '../deploy/service';
import { registerDeployHardeningHandlers } from './deployHardening';

/**
 * The Security center's channels answer only the main window and check every argument: the SSH
 * change says what to change, decisions name a change id, a backup passphrase is long enough, and
 * a restore names its file by a token from the open dialog, never a path.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const ID = '00000000-0000-4000-9000-000000000001';
const PASSPHRASE = 'orange tractor bicycle lamp';

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const hardening = {
    checklist: vi.fn(async () => ({})),
    previewSsh: vi.fn(async () => ({})),
    applySsh: vi.fn(async () => ({})),
    confirmSsh: vi.fn(async () => ({})),
    revertSsh: vi.fn(async () => ({})),
  };
  const backups = {
    create: vi.fn(async () => ({ saved: false })),
    pick: vi.fn(async () => null),
    resolve: vi.fn((token: string) => {
      if (token !== ID) throw new Error('Pick the backup file again.');
      return '/home/me/web.rnbackup';
    }),
  };
  const service = {
    restore: vi.fn(async (_input: unknown, onProgress: (p: unknown) => void) => {
      onProgress({ phase: 'stage', title: 'Stage', status: 'running' });
      return {};
    }),
  };
  const progress = vi.fn();
  registerDeployHardeningHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    hardening: hardening as unknown as DeployHardening,
    backups: backups as unknown as DeployBackups,
    service: service as unknown as Pick<DeployService, 'restore'>,
    restoreProgress: progress,
    guard: () => trusted,
  });
  const call = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { handlers, hardening, backups, service, progress, call };
}

const SSH = { serverId: 'srv-1', disablePasswordLogin: true, restrictRootLogin: false };
const RESTORE = {
  serverId: 'srv-1',
  fileToken: ID,
  passphrase: PASSPHRASE,
  sudoPassword: null,
  userName: 'maria',
  password: 'correct horse battery staple',
};

describe('registerDeployHardeningHandlers', () => {
  it('handles every invoke channel of the group', () => {
    const { handlers } = harness();
    const invokes = Object.entries(IPC.deployHardening)
      .filter(([name]) => !name.startsWith('on'))
      .map(([, channel]) => channel);

    expect([...handlers.keys()].sort()).toEqual(invokes.sort());
  });

  it('answers only the main window', async () => {
    const { call, hardening } = harness(false);

    await expect(call(IPC.deployHardening.checklist, 'srv-1')).rejects.toThrow(/main window/);
    expect(hardening.checklist).not.toHaveBeenCalled();
  });

  it('checks SSH changes and decisions', async () => {
    const { call, hardening } = harness();

    await call(IPC.deployHardening.previewSsh, SSH);
    await call(IPC.deployHardening.applySsh, { ...SSH, restrictRootLogin: true });
    await call(IPC.deployHardening.confirmSsh, { serverId: 'srv-1', changeId: ID });
    await call(IPC.deployHardening.revertSsh, { serverId: 'srv-1', changeId: ID });

    expect(hardening.applySsh).toHaveBeenCalledWith({ ...SSH, restrictRootLogin: true });
    await expect(
      call(IPC.deployHardening.applySsh, { ...SSH, disablePasswordLogin: false }),
    ).rejects.toThrow(/Say what to change/);
    await expect(
      call(IPC.deployHardening.applySsh, { ...SSH, disablePasswordLogin: 'yes' }),
    ).rejects.toThrow(/password login/);
    await expect(
      call(IPC.deployHardening.confirmSsh, { serverId: 'srv-1', changeId: '../x' }),
    ).rejects.toThrow(/not an SSH change/);
    await expect(call(IPC.deployHardening.checklist, '../etc')).rejects.toThrow();
  });

  it('checks the backup passphrase before anything happens', async () => {
    const { call, backups } = harness();

    await call(IPC.deployHardening.createBackup, { serverId: 'srv-1', passphrase: PASSPHRASE });
    await expect(
      call(IPC.deployHardening.createBackup, { serverId: 'srv-1', passphrase: 'short' }),
    ).rejects.toThrow(/at least 12/);

    expect(backups.create).toHaveBeenCalledTimes(1);
  });

  it('restores the picked file by its token and passes the steps to the window', async () => {
    const { call, service, progress } = harness();

    await call(IPC.deployHardening.restore, RESTORE);

    expect(service.restore).toHaveBeenCalledWith(
      {
        serverId: 'srv-1',
        passphrase: PASSPHRASE,
        sudoPassword: null,
        userName: 'maria',
        password: 'correct horse battery staple',
        file: '/home/me/web.rnbackup',
      },
      expect.any(Function),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.anything(),
      'srv-1',
      expect.objectContaining({ phase: 'stage' }),
    );
  });

  it('refuses a restore without a token from the dialog, or with a bad account', async () => {
    const { call, service } = harness();

    await expect(
      call(IPC.deployHardening.restore, { ...RESTORE, fileToken: '/etc/shadow' }),
    ).rejects.toThrow(/Pick the backup file again/);
    await expect(
      call(IPC.deployHardening.restore, {
        ...RESTORE,
        fileToken: '00000000-0000-4000-9000-000000000002',
      }),
    ).rejects.toThrow(/Pick the backup file again/);
    await expect(
      call(IPC.deployHardening.restore, { ...RESTORE, userName: 'a b' }),
    ).rejects.toThrow(/user name/);
    await expect(
      call(IPC.deployHardening.restore, { ...RESTORE, passphrase: 'two\nlines' }),
    ).rejects.toThrow(/passphrase/);
    await expect(
      call(IPC.deployHardening.restore, { ...RESTORE, sudoPassword: 5 }),
    ).rejects.toThrow(/sudo/);
    expect(service.restore).not.toHaveBeenCalled();
  });
});
