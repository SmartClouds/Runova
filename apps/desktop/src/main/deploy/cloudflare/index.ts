import { lookup } from 'node:dns/promises';
import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import type { SshRoute } from '../../../shared/apiTypes';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { registerCloudflareHandlers } from '../../ipc/cloudflare';
import { registerCloudflareServerHandlers } from '../../ipc/cloudflareServer';
import { registerCloudflareTunnelHandlers } from '../../ipc/cloudflareTunnel';
import { getMainWindow } from '../../mainWindow';
import { readTunnelSsh, updateTunnelSsh } from '../../ssh/savedServers';
import {
  decryptSecret,
  encryptSecret,
  isLockedEnvelope,
  registerSealedSecretStore,
} from '../../ssh/vault';
import { store } from '../../store';
import { isE2E } from '../../testMode';
import { setLiveDeployServices } from '../liveServices';
import { addressesFromCore, addressesOfHost, type ServerAddresses } from './pointDomain';
import { CloudflareServerOps } from './serverOps';
import { CloudflareService } from './service';
import { CloudflareState, cloudflareFilePort } from './state';
import { CloudflareTunnelOps, tunnelTarget } from './tunnel';

/**
 * Wires the Cloudflare dialog into Electron. The token is sealed with the Servers vault, so it moves
 * with a passkey change like the Deploy device keys. "Point domain to this server" takes the
 * public addresses the server's core reports, and the saved server's host when the core is not
 * there or knows of none. The server-side flows (origin lock, Origin CA, DNS-01 tokens) ride the
 * server's lasting core connection.
 */

export interface CloudflareCoreAccess {
  call: <T>(serverId: string, work: (hub: ICoreHub) => Promise<T>) => Promise<T>;
  roles: (serverId: string) => string[] | null;
  onLinkConnection: <T>(
    serverId: string,
    work: (sshConnection: string | undefined) => Promise<T>,
  ) => Promise<T>;
  serverName: (serverId: string) => Promise<string>;
  /** `$SSH_CONNECTION` over a brand-new SSH connection taking this route (E95). */
  probeSsh: (serverId: string, route: SshRoute) => Promise<string>;
  /** Drops the server's SSH connections and its link, so new ones take its new route. */
  resetSsh: (serverId: string) => void;
  withCoreDomainHub: <T>(serverId: string, work: (hub: ICoreHub) => Promise<T>) => Promise<T>;
}

/** How long point-domain waits for a core's addresses before using the saved host. */
const CORE_ADDRESS_TIMEOUT_MS = 8_000;

/**
 * The recorded Cloudflare fake for e2e runs, served on loopback by the test. Honoured only in an
 * e2e run of an unpackaged build: a packaged app always talks to api.cloudflare.com.
 */
function cloudflareApiBase(): string | undefined {
  const base = process.env.RUNOVA_E2E_CLOUDFLARE_API;
  if (!isE2E || app.isPackaged || !base) return undefined;
  return /^http:\/\/127\.0\.0\.1:\d{1,5}\/client\/v4$/.test(base) ? base : undefined;
}

async function savedServerAddresses(
  serverId: string,
  core: CloudflareCoreAccess | undefined,
): Promise<ServerAddresses> {
  if (core) {
    try {
      const info = await Promise.race([
        core.call(serverId, (hub) => hub.getSystemInfo()),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), CORE_ADDRESS_TIMEOUT_MS),
        ),
      ]);
      const reported = addressesFromCore(info.publicAddresses);
      if (reported) return reported;
    } catch {
      // No core on this server, or it is not answering: the saved host still says where it is.
    }
  }
  const server = (await store.getSshServers()).find((candidate) => candidate.id === serverId);
  if (!server) throw new Error('This saved server no longer exists.');
  return addressesOfHost(server.host, (host) => lookup(host, { all: true, verbatim: true }));
}

/** Where a server's Cloudflare Tunnel takes traffic, when it has one that is on (E95). */
async function tunnelTargetOf(
  serverId: string,
  core: CloudflareCoreAccess,
): Promise<string | null> {
  try {
    const status = await Promise.race([
      core.call(serverId, (hub) => hub.getCloudflareTunnel()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), CORE_ADDRESS_TIMEOUT_MS),
      ),
    ]);
    return status.enabled && status.tunnelId ? tunnelTarget(status.tunnelId) : null;
  } catch {
    // No core, or one from before the tunnel: the server's addresses it is.
    return null;
  }
}

export function registerCloudflareIpc(core?: CloudflareCoreAccess): void {
  const state = new CloudflareState(
    cloudflareFilePort(join(app.getPath('userData'), 'data', 'cloudflare.json')),
  );
  registerSealedSecretStore(state.sealedKeys);
  const baseURL = cloudflareApiBase();
  const service = new CloudflareService({
    state,
    seal: encryptSecret,
    unseal: decryptSecret,
    isLocked: isLockedEnvelope,
    addresses: (serverId) => savedServerAddresses(serverId, core),
    ...(core ? { tunnelTarget: (serverId: string) => tunnelTargetOf(serverId, core) } : {}),
    ...(baseURL ? { baseURL, maxRetries: 0 } : {}),
  });
  const guard = (event: Electron.IpcMainInvokeEvent) => {
    const win = getMainWindow();
    return (
      !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
    );
  };
  setLiveDeployServices({ cloudflare: service });
  registerCloudflareHandlers({ ipc: ipcMain, service, guard });
  if (core) {
    registerCloudflareServerHandlers({
      ipc: ipcMain,
      ops: new CloudflareServerOps({
        cloudflare: service,
        links: { call: core.call },
        roles: core.roles,
        onLinkConnection: core.onLinkConnection,
        serverName: core.serverName,
      }),
      guard,
    });
    registerCloudflareTunnelHandlers({
      ipc: ipcMain,
      ops: new CloudflareTunnelOps({
        cloudflare: service,
        links: { call: core.call },
        roles: core.roles,
        onLinkConnection: core.onLinkConnection,
        serverName: core.serverName,
        addresses: (serverId) => savedServerAddresses(serverId, core),
        tunnelSsh: { read: readTunnelSsh, update: updateTunnelSsh, seal: encryptSecret },
        probeSsh: core.probeSsh,
        resetSsh: core.resetSsh,
        withCoreDomainHub: core.withCoreDomainHub,
      }),
      guard,
    });
  }
}
