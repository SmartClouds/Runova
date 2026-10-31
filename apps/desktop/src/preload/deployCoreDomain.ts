import { ipcRenderer } from 'electron';
import type {
  DeployCoreDomainEnableInput,
  DeployCoreDomainInfo,
} from '../shared/deployCoreDomainTypes';
import { IPC } from '../shared/ipcChannels';

/**
 * The core domain (E44), for the Connection tab of the server's Security section. Turning it on
 * may need a step-up (`[core:stepUpRequired]`): pass the password or a code, as the Firewall
 * does. A role below Owner comes back as `[core:forbidden]`.
 */
export function createDeployCoreDomain() {
  return {
    status: (serverId: string): Promise<DeployCoreDomainInfo> =>
      ipcRenderer.invoke(IPC.deployCoreDomain.status, serverId),
    enable: (input: DeployCoreDomainEnableInput): Promise<DeployCoreDomainInfo> =>
      ipcRenderer.invoke(IPC.deployCoreDomain.enable, input),
    disable: (serverId: string): Promise<DeployCoreDomainInfo> =>
      ipcRenderer.invoke(IPC.deployCoreDomain.disable, serverId),
    check: (serverId: string): Promise<DeployCoreDomainInfo> =>
      ipcRenderer.invoke(IPC.deployCoreDomain.check, serverId),
  };
}
