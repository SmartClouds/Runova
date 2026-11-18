import { lookup } from 'node:dns/promises';
import { hostname as computerName } from 'node:os';
import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import type { SshRoute } from '../../../shared/apiTypes';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { registerCloudflareHandlers } from '../../ipc/cloudflare';
import { registerCloudflareEmailGateHandlers } from '../../ipc/cloudflareEmailGate';
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
import type { AccessPassLookup } from '../coreDomain/transport';
import { setLiveDeployServices } from '../liveServices';
import { CloudflareEmailGateOps, type EmailGateServer } from './emailGate';
import { CloudflareGeolocation } from './geolocation';
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
  /** The saved servers, for what each name on the Access tab is (E96). */
  servers: () => Promise<EmailGateServer[]>;
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

/**
 * This computer's pass through an email code gate on a domain (E96), for the core domain
 * transport. Null until the Cloudflare page is wired, and for a domain with no pass.
 */
let passes: CloudflareState | null = null;

export const accessPassFor: AccessPassLookup = async (domain) => {
  const pass = await passes?.pass(domain);
  if (!pass || isLockedEnvelope(pass.clientSecret)) return null;
  try {
    return { clientId: pass.clientId, clientSecret: await decryptSecret(pass.clientSecret) };
  } catch {
    return null;
  }
};

export function registerCloudflareIpc(core?: CloudflareCoreAccess): void {
  const state = new CloudflareState(
    cloudflareFilePort(join(app.getPath('userData'), 'data', 'cloudflare.json')),
  );
  registerSealedSecretStore(state.sealedKeys);
  passes = state;
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
    const serverOps = new CloudflareServerOps({
      cloudflare: service,
      links: { call: core.call },
      roles: core.roles,
      onLinkConnection: core.onLinkConnection,
      serverName: core.serverName,
    });
    setLiveDeployServices({ cloudflareServer: serverOps });
    // The traffic report's visitor location (E109): read and turned on with the token kept here.
    setLiveDeployServices({
      cloudflareGeolocation: new CloudflareGeolocation({
        cloudflare: service,
        links: { call: core.call },
        roles: core.roles,
      }),
    });
    registerCloudflareServerHandlers({ ipc: ipcMain, ops: serverOps, guard });
    const tunnelOps = new CloudflareTunnelOps({
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
    });
    setLiveDeployServices({ cloudflareTunnel: tunnelOps });
    registerCloudflareTunnelHandlers({ ipc: ipcMain, ops: tunnelOps, guard });
    const emailGate = new CloudflareEmailGateOps({
      cloudflare: service,
      passes: state,
      seal: encryptSecret,
      servers: core.servers,
      links: { call: core.call },
      computerName,
    });
    setLiveDeployServices({ cloudflareEmailGate: emailGate });
    registerCloudflareEmailGateHandlers({ ipc: ipcMain, ops: emailGate, guard });
  }
}
