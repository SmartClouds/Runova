import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import {
  type CloudflareTunnelHandlerDeps,
  registerCloudflareTunnelHandlers,
} from './cloudflareTunnel';

/** The tunnel's channels (E95) answer only the main window and check every argument. */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const ACCOUNT = '699d98642c564d2e855e9661899b7252';

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const names = Object.keys(IPC.cloudflareTunnel);
  const ops = Object.fromEntries(names.map((name) => [name, vi.fn(async () => undefined)]));
  registerCloudflareTunnelHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    ops: ops as unknown as CloudflareTunnelHandlerDeps['ops'],
    guard: () => trusted,
  });
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { ops, call, handlers };
}

describe('registerCloudflareTunnelHandlers', () => {
  it('handles every channel in the group, for the main window only', async () => {
    const { handlers, call, ops } = harness(false);

    expect([...handlers.keys()].sort()).toEqual(Object.values(IPC.cloudflareTunnel).sort());
    await expect(call(IPC.cloudflareTunnel.status, 'srv-1')).rejects.toThrow(/main window/);
    expect(ops.status).not.toHaveBeenCalled();
  });

  it('passes checked arguments through and drops anything else', async () => {
    const { ops, call } = harness();

    await call(IPC.cloudflareTunnel.setUp, {
      serverId: 'srv-1',
      cloudflareAccountId: ACCOUNT,
      sshHostname: ' SSH-Prod.Example.com ',
      token: 'never wanted',
    });
    await call(IPC.cloudflareTunnel.applySsh, {
      serverId: 'srv-1',
      mode: 'closed',
      overrideConfirmation: 'apply without the ssh check',
      password: 'pw',
    });
    await call(IPC.cloudflareTunnel.probeSsh, 'srv-1', 'mesh');
    await call(IPC.cloudflareTunnel.turnOff, { serverId: 'srv-1', reopenWeb: false });
    await call(IPC.cloudflareTunnel.cleanUp, 'srv-1', true);
    await call(IPC.cloudflareTunnel.breakGlass, {
      serverId: 'srv-1',
      enabled: true,
      delayMinutes: 30,
    });

    expect(ops.setUp).toHaveBeenCalledWith({
      serverId: 'srv-1',
      cloudflareAccountId: ACCOUNT,
      sshHostname: 'ssh-prod.example.com',
    });
    expect(ops.applySsh).toHaveBeenCalledWith({
      serverId: 'srv-1',
      mode: 'closed',
      overrideConfirmation: 'apply without the ssh check',
      password: 'pw',
    });
    expect(ops.probeSsh).toHaveBeenCalledWith('srv-1', 'mesh');
    expect(ops.turnOff).toHaveBeenCalledWith({ serverId: 'srv-1', reopenWeb: false });
    expect(ops.cleanUp).toHaveBeenCalledWith('srv-1', true);
    expect(ops.breakGlass).toHaveBeenCalledWith({
      serverId: 'srv-1',
      enabled: true,
      delayMinutes: 30,
    });
  });

  it('refuses what is not the right shape', async () => {
    const { ops, call } = harness();

    await expect(call(IPC.cloudflareTunnel.status, '../etc')).rejects.toThrow(/saved server/);
    await expect(
      call(IPC.cloudflareTunnel.setUp, {
        serverId: 'srv-1',
        cloudflareAccountId: 'nope',
        sshHostname: null,
      }),
    ).rejects.toThrow(/Cloudflare account/);
    await expect(
      call(IPC.cloudflareTunnel.setUp, {
        serverId: 'srv-1',
        cloudflareAccountId: ACCOUNT,
        sshHostname: 'not a name',
      }),
    ).rejects.toThrow(/host name/);
    await expect(
      call(IPC.cloudflareTunnel.applySsh, { serverId: 'srv-1', mode: 'everyone' }),
    ).rejects.toThrow(/who may open SSH/);
    await expect(call(IPC.cloudflareTunnel.probeSsh, 'srv-1', 'direct')).rejects.toThrow(/route/);
    await expect(
      call(IPC.cloudflareTunnel.breakGlass, { serverId: 'srv-1', enabled: true, delayMinutes: 2 }),
    ).rejects.toThrow(/5 minutes/);
    expect(ops.setUp).not.toHaveBeenCalled();
    expect(ops.applySsh).not.toHaveBeenCalled();
    expect(ops.breakGlass).not.toHaveBeenCalled();
  });
});
