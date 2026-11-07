import type {
  NetworkInfo,
  StackServiceNetworks,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * Networks an app's service joins besides its own, so it reaches another app's containers by
 * their service names. They are saved with the app's revision, so a redeploy keeps them.
 */

/**
 * The networks a service of the app can still join: not Docker's own (bridge, host, none), not
 * the app's own (Compose puts its services there already) and not one it joined. Other apps'
 * networks come first, since joining one of those is what people do most.
 */
export function joinableNetworks(
  all: readonly NetworkInfo[],
  app: string,
  joined: readonly string[],
): NetworkInfo[] {
  const taken = new Set(joined);
  return all
    .filter(
      (network) => !network.builtIn && network.composeProject !== app && !taken.has(network.name),
    )
    .sort(
      (a, b) =>
        Number(!a.composeProject) - Number(!b.composeProject) || a.name.localeCompare(b.name),
    );
}

/** A short line on a network for the picker: whose it is and what is on it. */
export function describeNetwork(network: NetworkInfo): string {
  const parts: string[] = [];
  if (network.composeProject) parts.push(`App ${network.composeProject}`);
  parts.push(
    network.containers === 0
      ? parts.length === 0
        ? 'No containers'
        : 'no containers'
      : `${network.containers} ${network.containers === 1 ? 'container' : 'containers'}`,
  );
  if (network.internal) parts.push('internal only');
  return parts.join(' · ');
}

/** One service's joined networks in a revision. Older cores send none at all. */
export function networksOf(
  entries: readonly StackServiceNetworks[] | undefined,
  service: string,
): string[] {
  return [...(entries?.find((entry) => entry.service === service)?.networks ?? [])];
}

/** The whole list a revision gets when one service's networks change; services that join nothing drop out. */
export function withServiceNetworks(
  entries: readonly StackServiceNetworks[],
  service: string,
  networks: readonly string[],
): StackServiceNetworks[] {
  const next = [...new Set(networks)];
  const others = entries.filter((entry) => entry.service !== service);
  const index = entries.findIndex((entry) => entry.service === service);
  if (next.length === 0) return others;
  const updated = { service, networks: next };
  if (index < 0) return [...others, updated];
  return entries.map((entry) => (entry.service === service ? updated : entry));
}
