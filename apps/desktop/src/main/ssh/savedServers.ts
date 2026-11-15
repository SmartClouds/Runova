import type { SshRoute, StoredSshServer, StoredTunnelSsh } from '../../shared/apiTypes';
import { orderById } from '../../shared/orderById';
import { store } from '../store';
import type { SshEndpoint } from './connectConfig';
import type { PoolSource } from './pool';
import { decryptSecret } from './vault';

/**
 * Saved SSH servers (the Remote section's list) as connection endpoints, and the one write queue
 * for `ssh-servers.json`. Terminal sessions and Deploy connections both record host keys and
 * connect times here; without a shared queue their read-modify-write cycles could interleave and
 * one would silently lose the other's change.
 */

let updateQueue: Promise<void> = Promise.resolve();

export function updateSshServer(
  id: string,
  update: (server: StoredSshServer) => StoredSshServer,
): Promise<void> {
  const next = updateQueue.then(async () => {
    const servers = await store.getSshServers();
    const index = servers.findIndex((s) => s.id === id);
    if (index < 0) return;
    const updated = [...servers];
    updated[index] = update(updated[index]);
    await store.setSshServers(updated);
  });
  updateQueue = next.catch(() => undefined);
  return next;
}

/**
 * Saves the servers in the order the Remote page's list was dragged into and returns them. It runs
 * on the same queue as `updateSshServer`, so a connect finishing mid-drop can't lose either write.
 */
export function reorderSshServers(orderedIds: string[]): Promise<StoredSshServer[]> {
  let reordered: StoredSshServer[] = [];
  const next = updateQueue.then(async () => {
    reordered = orderById(await store.getSshServers(), orderedIds);
    await store.setSshServers(reordered);
  });
  updateQueue = next.catch(() => undefined);
  return next.then(() => reordered);
}

export async function findSavedServer(serverId: string): Promise<StoredSshServer> {
  const server = (await store.getSshServers()).find((s) => s.id === serverId);
  if (!server) throw new Error('This saved server no longer exists.');
  return server;
}

/** The endpoint for a saved server with its password or key passphrase decrypted. */
export async function savedServerEndpoint(serverId: string): Promise<SshEndpoint> {
  const server = await findSavedServer(serverId);
  return endpointOf(server, server.sshRoute);
}

/** The endpoint as if SSH took this route: what a test connection over it uses before it is on. */
export async function routedServerEndpoint(
  serverId: string,
  route: SshRoute,
): Promise<SshEndpoint> {
  const server = await findSavedServer(serverId);
  const endpoint = await endpointOf(server, route);
  if (route === 'cloudflare' && !endpoint.via) {
    throw new Error('SSH has no name on the tunnel yet. Route the tunnel first.');
  }
  if (route === 'mesh' && endpoint.host === server.host) {
    throw new Error('This server has no Mesh address yet. Add it to Mesh first.');
  }
  return endpoint;
}

async function endpointOf(
  server: StoredSshServer,
  route: SshRoute | undefined,
): Promise<SshEndpoint> {
  let password: string | undefined;
  let passphrase: string | undefined;
  if (server.secretEnvelope) {
    const secret = await decryptSecret(server.secretEnvelope);
    if (server.authMethod === 'password') password = secret;
    else passphrase = secret;
  }
  const tunnel = server.cloudflareTunnel;
  const endpoint: SshEndpoint = {
    host: server.host,
    port: server.port,
    username: server.username,
    authMethod: server.authMethod,
    password,
    privateKeyPath: server.privateKeyPath,
    passphrase,
    storedFingerprint: server.hostKeyFingerprint,
  };
  // Through the tunnel (E95): the same login and pinned host key, another way to the server.
  if (route === 'mesh' && tunnel?.meshAddress) {
    return { ...endpoint, host: tunnel.meshAddress };
  }
  if (route === 'cloudflare' && tunnel?.hostname && tunnel.clientId && tunnel.clientSecret) {
    return {
      ...endpoint,
      via: {
        kind: 'cloudflare',
        hostname: tunnel.hostname,
        clientId: tunnel.clientId,
        clientSecret: await decryptSecret(tunnel.clientSecret),
      },
    };
  }
  return endpoint;
}

/**
 * What the app keeps about a server's tunnel for SSH; empty when nothing, or when the server is
 * not a saved SSH server at all (the DevHost), which has no SSH to route.
 */
export async function readTunnelSsh(serverId: string): Promise<StoredTunnelSsh> {
  const server = (await store.getSshServers()).find((candidate) => candidate.id === serverId);
  return server?.cloudflareTunnel ?? {};
}

/** Changes what the app keeps about a server's tunnel for SSH, and which route SSH takes. */
export function updateTunnelSsh(
  serverId: string,
  change: (current: StoredTunnelSsh) => StoredTunnelSsh | undefined,
  route?: SshRoute | null,
): Promise<void> {
  return updateSshServer(serverId, (server) => {
    const { cloudflareTunnel: current, sshRoute: currentRoute, ...rest } = server;
    const tunnel = change(current ?? {});
    const nextRoute = route === undefined ? currentRoute : (route ?? undefined);
    return {
      ...rest,
      ...(tunnel ? { cloudflareTunnel: tunnel } : {}),
      ...(nextRoute ? { sshRoute: nextRoute } : {}),
    };
  });
}

/** Where the Deploy connection pool gets its endpoints and records what it learned. */
export const savedServerPoolSource: PoolSource = {
  endpoint: savedServerEndpoint,
  // First use only: never replace a key that was already trusted.
  trustHostKey: (serverId, fingerprint) =>
    updateSshServer(serverId, (s) => ({
      ...s,
      hostKeyFingerprint: s.hostKeyFingerprint ?? fingerprint,
    })),
  connected: (serverId) => {
    void updateSshServer(serverId, (s) => ({ ...s, lastConnectedAt: Date.now() }));
  },
};
