import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import {
  type CloudflareEmailGateHandlerDeps,
  registerCloudflareEmailGateHandlers,
} from './cloudflareEmailGate';

/** The email code gate's channels (E96) answer only the main window and check every argument. */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const ZONE = '023e105f4ecef8ad9ca31a8372d0c353';

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const names = Object.keys(IPC.cloudflareEmailGate);
  const ops = Object.fromEntries(names.map((name) => [name, vi.fn(async () => undefined)]));
  registerCloudflareEmailGateHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    ops: ops as unknown as CloudflareEmailGateHandlerDeps['ops'],
    guard: () => trusted,
  });
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { ops, call, handlers };
}

describe('registerCloudflareEmailGateHandlers', () => {
  it('handles every channel in the group, for the main window only', async () => {
    const { handlers, call, ops } = harness(false);

    expect([...handlers.keys()].sort()).toEqual(Object.values(IPC.cloudflareEmailGate).sort());
    await expect(call(IPC.cloudflareEmailGate.plan, ZONE)).rejects.toThrow(/main window/);
    expect(ops.plan).not.toHaveBeenCalled();
  });

  it('passes checked arguments through, tidied, and drops anything else', async () => {
    const { ops, call } = harness();

    await call(IPC.cloudflareEmailGate.plan, ZONE);
    await call(IPC.cloudflareEmailGate.find, ' Core.Example.com ');
    await call(IPC.cloudflareEmailGate.prepare, { zoneId: ZONE, teamName: ' acme ', extra: 1 });
    await call(IPC.cloudflareEmailGate.save, {
      zoneId: ZONE,
      hostname: ' Blog.Example.com ',
      emails: ['Ana@Example.com'],
      emailDomains: ['Company.com'],
      session: '168h',
      appId: 'not wanted',
    });
    await call(IPC.cloudflareEmailGate.remove, { zoneId: ZONE, hostname: 'blog.example.com' });
    await call(IPC.cloudflareEmailGate.letThisComputerThrough, {
      zoneId: ZONE,
      hostname: 'core.example.com',
    });
    await call(IPC.cloudflareEmailGate.proxy, { zoneId: ZONE, hostname: 'shop.example.com' });

    expect(ops.plan).toHaveBeenCalledWith(ZONE);
    expect(ops.find).toHaveBeenCalledWith('core.example.com');
    expect(ops.prepare).toHaveBeenCalledWith({ zoneId: ZONE, teamName: 'acme' });
    expect(ops.save).toHaveBeenCalledWith({
      zoneId: ZONE,
      hostname: 'blog.example.com',
      emails: ['ana@example.com'],
      emailDomains: ['company.com'],
      session: '168h',
    });
    expect(ops.remove).toHaveBeenCalledWith({ zoneId: ZONE, hostname: 'blog.example.com' });
    expect(ops.letThisComputerThrough).toHaveBeenCalledWith({
      zoneId: ZONE,
      hostname: 'core.example.com',
    });
    expect(ops.proxy).toHaveBeenCalledWith({ zoneId: ZONE, hostname: 'shop.example.com' });
  });

  it('refuses what does not fit before it reaches Cloudflare', async () => {
    const { ops, call } = harness();
    const save = (change: Record<string, unknown>) =>
      call(IPC.cloudflareEmailGate.save, {
        zoneId: ZONE,
        hostname: 'blog.example.com',
        emails: ['ana@example.com'],
        emailDomains: [],
        session: '24h',
        ...change,
      });

    await expect(call(IPC.cloudflareEmailGate.plan, 'nope')).rejects.toThrow(/zone/);
    await expect(save({ hostname: '*.example.com' })).rejects.toThrow(/hostname/);
    await expect(save({ session: '1h' })).rejects.toThrow(/how long/);
    await expect(save({ emails: 'ana@example.com' })).rejects.toThrow(/list/);
    await expect(save({ emails: Array(101).fill('a@b.io') })).rejects.toThrow(/list/);
    await expect(save({ emails: [42] })).rejects.toThrow(/email/);
    await expect(
      call(IPC.cloudflareEmailGate.prepare, { zoneId: ZONE, teamName: 'x'.repeat(80) }),
    ).rejects.toThrow(/team name/);
    expect(ops.save).not.toHaveBeenCalled();
    expect(ops.prepare).not.toHaveBeenCalled();
  });
});
