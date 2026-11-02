import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type { DeployCoreDomain } from '../deploy/coreDomain/service';
import { registerDeployCoreDomainHandlers } from './deployCoreDomain';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const coreDomain = {
    status: vi.fn(async () => ({})),
    enable: vi.fn(async () => ({})),
    disable: vi.fn(async () => ({})),
    check: vi.fn(async () => ({})),
  };
  registerDeployCoreDomainHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    coreDomain: coreDomain as unknown as DeployCoreDomain,
    guard: () => trusted,
  });
  const call = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { handlers, coreDomain, call };
}

describe('registerDeployCoreDomainHandlers', () => {
  it('handles every channel of the group', () => {
    const { handlers } = harness();

    expect([...handlers.keys()].sort()).toEqual(Object.values(IPC.deployCoreDomain).sort());
  });

  it('answers only the main window', async () => {
    const { call, coreDomain } = harness(false);

    await expect(call(IPC.deployCoreDomain.status, 'srv-1')).rejects.toThrow(/main window/);
    expect(coreDomain.status).not.toHaveBeenCalled();
  });

  it('passes the server id through for status, disable and check', async () => {
    const { call, coreDomain } = harness();

    await call(IPC.deployCoreDomain.status, 'srv-1');
    await call(IPC.deployCoreDomain.disable, 'srv-1');
    await call(IPC.deployCoreDomain.check, 'srv-1');

    expect(coreDomain.status).toHaveBeenCalledWith('srv-1');
    expect(coreDomain.disable).toHaveBeenCalledWith('srv-1');
    expect(coreDomain.check).toHaveBeenCalledWith('srv-1');
  });

  it('checks the domain and the sources before anything reaches the core', async () => {
    const { call, coreDomain } = harness();

    await call(IPC.deployCoreDomain.enable, {
      serverId: 'srv-1',
      domain: ' Core.Example.com ',
      sources: ['203.0.113.7'],
      password: 'pw',
    });
    const wildcard = call(IPC.deployCoreDomain.enable, {
      serverId: 'srv-1',
      domain: '*.example.com',
      sources: [],
    });
    const url = call(IPC.deployCoreDomain.enable, {
      serverId: 'srv-1',
      domain: 'https://core.example.com',
      sources: [],
    });
    const badSources = call(IPC.deployCoreDomain.enable, {
      serverId: 'srv-1',
      domain: 'core.example.com',
      sources: ['not a network'],
    });

    expect(coreDomain.enable).toHaveBeenCalledWith({
      serverId: 'srv-1',
      domain: 'core.example.com',
      sources: ['203.0.113.7'],
      password: 'pw',
    });
    await expect(wildcard).rejects.toThrow(/wildcard/);
    await expect(url).rejects.toThrow(/without https/);
    await expect(badSources).rejects.toThrow();
    expect(coreDomain.enable).toHaveBeenCalledTimes(1);
  });

  it('passes Through Cloudflare on, and refuses a mode it does not know', async () => {
    const { call, coreDomain } = harness();

    await call(IPC.deployCoreDomain.enable, {
      serverId: 'srv-1',
      domain: 'core.example.com',
      sources: [],
      mode: 'cloudflare',
    });
    await call(IPC.deployCoreDomain.enable, {
      serverId: 'srv-1',
      domain: 'core.example.com',
      sources: [],
      mode: 'direct',
    });
    const unknown = call(IPC.deployCoreDomain.enable, {
      serverId: 'srv-1',
      domain: 'core.example.com',
      sources: [],
      mode: 'tunnel',
    });

    expect(coreDomain.enable).toHaveBeenNthCalledWith(1, {
      serverId: 'srv-1',
      domain: 'core.example.com',
      sources: [],
      mode: 'cloudflare',
    });
    expect(coreDomain.enable).toHaveBeenNthCalledWith(2, {
      serverId: 'srv-1',
      domain: 'core.example.com',
      sources: [],
    });
    await expect(unknown).rejects.toThrow(/straight to the server or through Cloudflare/);
  });
});
