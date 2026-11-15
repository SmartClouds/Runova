import { ipcRenderer } from 'electron';
import type { SshRoute } from '../shared/apiTypes';
import type {
  CloudflareSshProbe,
  CloudflareTunnelBreakGlassInput,
  CloudflareTunnelOffInput,
  CloudflareTunnelPlan,
  CloudflareTunnelRouteResult,
  CloudflareTunnelSetupInput,
  CloudflareTunnelSshInput,
} from '../shared/cloudflareTypes';
import type {
  CloudflareTunnelPreview,
  CloudflareTunnelResult,
  CloudflareTunnelStatus,
  JobInfo,
} from '../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { IPC } from '../shared/ipcChannels';

/**
 * The Cloudflare Tunnel on one server (E95). The account token and the tunnel's own token never
 * cross here; firewall steps come back as change sets the Firewall section keeps or reverts.
 */
export const cloudflareTunnel = {
  status: (serverId: string): Promise<CloudflareTunnelStatus> =>
    ipcRenderer.invoke(IPC.cloudflareTunnel.status, serverId),
  /** The accounts, names and firewall preview the setup dialog shows. Changes nothing. */
  plan: (serverId: string): Promise<CloudflareTunnelPlan> =>
    ipcRenderer.invoke(IPC.cloudflareTunnel.plan, serverId),
  /** Makes the tunnel at Cloudflare and starts the job that connects it. */
  setUp: (input: CloudflareTunnelSetupInput): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.cloudflareTunnel.setUp, input),
  /** Points the server's names at the tunnel, and SSH's name behind Cloudflare Access. */
  route: (serverId: string): Promise<CloudflareTunnelRouteResult> =>
    ipcRenderer.invoke(IPC.cloudflareTunnel.route, serverId),
  closePorts: (serverId: string): Promise<CloudflareTunnelResult> =>
    ipcRenderer.invoke(IPC.cloudflareTunnel.closePorts, serverId),
  previewSsh: (input: CloudflareTunnelSshInput): Promise<CloudflareTunnelPreview> =>
    ipcRenderer.invoke(IPC.cloudflareTunnel.previewSsh, input),
  /** Tries a new SSH connection over the route and says from where the server saw it. */
  probeSsh: (serverId: string, route: SshRoute): Promise<CloudflareSshProbe> =>
    ipcRenderer.invoke(IPC.cloudflareTunnel.probeSsh, serverId, route),
  applySsh: (input: CloudflareTunnelSshInput): Promise<CloudflareTunnelResult> =>
    ipcRenderer.invoke(IPC.cloudflareTunnel.applySsh, input),
  previewOff: (input: CloudflareTunnelOffInput): Promise<CloudflareTunnelPreview> =>
    ipcRenderer.invoke(IPC.cloudflareTunnel.previewOff, input),
  turnOff: (input: CloudflareTunnelOffInput): Promise<CloudflareTunnelResult> =>
    ipcRenderer.invoke(IPC.cloudflareTunnel.turnOff, input),
  /** Once off: the names point straight back and the tunnel goes at Cloudflare. */
  cleanUp: (serverId: string, pointBack: boolean): Promise<CloudflareTunnelRouteResult> =>
    ipcRenderer.invoke(IPC.cloudflareTunnel.cleanUp, serverId, pointBack),
  joinMesh: (serverId: string): Promise<JobInfo> =>
    ipcRenderer.invoke(IPC.cloudflareTunnel.joinMesh, serverId),
  breakGlass: (input: CloudflareTunnelBreakGlassInput): Promise<CloudflareTunnelStatus> =>
    ipcRenderer.invoke(IPC.cloudflareTunnel.breakGlass, input),
};
