import type { IpcMainInvokeEvent } from 'electron';
import { checkCoreDomainName } from '../../shared/deploy/coreDomainValidation';
import { checkSources } from '../../shared/deploy/directTlsValidation';
import type { DeployCoreDomainEnableInput } from '../../shared/deployCoreDomainTypes';
import { IPC } from '../../shared/ipcChannels';
import type { DeployCoreDomain } from '../deploy/coreDomain/service';
import { type DeployIpcRegistry, object, serverId, stepUpInput } from './deploy';

/**
 * Core domain channels (E44): how it stands, turning it on and off, and checking it from this
 * computer. Main window only, every argument checked here; the core checks the domain and sources
 * again and decides who may change them.
 */

export interface DeployCoreDomainHandlerDeps {
  ipc: DeployIpcRegistry;
  coreDomain: Pick<DeployCoreDomain, 'status' | 'enable' | 'disable' | 'check'>;
  /** True only for the main window's own frame. */
  guard: (event: IpcMainInvokeEvent) => boolean;
}

export function enableInput(value: unknown): DeployCoreDomainEnableInput {
  const input = object(value, 'core domain settings');
  const proof = stepUpInput(value);
  const domain = typeof input.domain === 'string' ? checkCoreDomainName(input.domain) : null;
  if (!domain?.ok)
    throw new Error(domain?.reason ?? 'The domain is text, such as core.example.com.');
  if (!Array.isArray(input.sources) || input.sources.some((item) => typeof item !== 'string')) {
    throw new Error('The sources must be a list of addresses or networks.');
  }
  const sources = checkSources(input.sources as string[]);
  if (!sources.ok) throw new Error(sources.reason);
  return { ...proof, domain: domain.value, sources: sources.value };
}

export function registerDeployCoreDomainHandlers(deps: DeployCoreDomainHandlerDeps): void {
  const { ipc, coreDomain } = deps;
  const handle = (channel: string, run: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!deps.guard(event)) throw new Error('Deploy is only available in the main window.');
      return run(...args);
    });
  };

  handle(IPC.deployCoreDomain.status, (id) => coreDomain.status(serverId(id)));
  handle(IPC.deployCoreDomain.enable, (value) => coreDomain.enable(enableInput(value)));
  handle(IPC.deployCoreDomain.disable, (id) => coreDomain.disable(serverId(id)));
  handle(IPC.deployCoreDomain.check, (id) => coreDomain.check(serverId(id)));
}
