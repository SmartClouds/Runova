import type { StackServiceNetworks } from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * The networks an app's services join, as they cross IPC: each service once, each network a
 * Docker network name that is not one of Docker's own. The core checks again that the services
 * exist and the networks are on the server when it validates the revision.
 */

const MAX_SERVICES = 200;
export const MAX_NETWORKS_PER_SERVICE = 16;
const SERVICE = /^[a-zA-Z0-9._-]{1,128}$/;
const NETWORK = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const BUILT_IN = new Set(['bridge', 'host', 'none']);

export function networksInput(value: unknown): StackServiceNetworks[] {
  if (!Array.isArray(value)) throw new Error('The networks are not a list.');
  if (value.length > MAX_SERVICES) {
    throw new Error(`Name networks for at most ${MAX_SERVICES} services.`);
  }
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) throw new Error('A service entry is not one.');
    const entry = item as Record<string, unknown>;
    if (typeof entry.service !== 'string' || !SERVICE.test(entry.service)) {
      throw new Error('The networks name a service that is not a service name.');
    }
    if (seen.has(entry.service)) throw new Error(`${entry.service} has its networks listed twice.`);
    seen.add(entry.service);
    const networks = entry.networks;
    if (!Array.isArray(networks) || networks.length > MAX_NETWORKS_PER_SERVICE) {
      throw new Error(`A service can join at most ${MAX_NETWORKS_PER_SERVICE} networks.`);
    }
    for (const network of networks) {
      if (typeof network !== 'string' || !NETWORK.test(network)) {
        throw new Error(
          'A network name can have letters, digits, dots, dashes and underscores only.',
        );
      }
      if (BUILT_IN.has(network)) {
        throw new Error(
          `${network} is one of Docker's own networks, which an app's service cannot join.`,
        );
      }
    }
    return { service: entry.service, networks: [...new Set(networks as string[])] };
  });
}
