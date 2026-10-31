import { HEALTH_DEFAULT_PATH } from '@runova/core';
import type {
  SiteInfo,
  StackDetails,
  StackPortBinding,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { bindingAddress, isPublicBinding } from './format';

/**
 * The route map's view of Websites: which domains already lead to a published port, and whether
 * nginx can put one on a domain. nginx reaches a port on 127.0.0.1, so only TCP ports that listen
 * there (or on every address) can sit behind a site.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The port on the server, or null when it is not one fixed number (unset or a range). */
export function publishedPort(binding: Pick<StackPortBinding, 'published'>): number | null {
  const published = binding.published?.trim() ?? '';
  if (!/^\d{1,5}$/.test(published)) return null;
  const port = Number(published);
  return port >= 1 && port <= 65_535 ? port : null;
}

function forwardsTo(site: SiteInfo, port: number): boolean {
  const upstream = site.settings.upstream;
  if (upstream.kind === 'servicePort') return upstream.port === port;
  if (upstream.kind !== 'url' || !upstream.address) return false;
  try {
    const url = new URL(upstream.address);
    const urlPort = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return LOOPBACK_HOSTS.has(url.hostname) && urlPort === port;
  } catch {
    return false;
  }
}

/** Every domain of the sites that forward to this port, in the order Websites lists them. */
export function domainsForPort(sites: readonly SiteInfo[], port: number): string[] {
  return sites.filter((site) => forwardsTo(site, port)).flatMap((site) => site.settings.domains);
}

/** Why this port cannot be put on a domain, or null when it can. */
export function proxyBlockReason(binding: StackPortBinding): string | null {
  if (binding.protocol.toLowerCase() === 'udp') {
    return 'Websites forward HTTP, which runs over TCP. A UDP port needs a TCP or UDP proxy in Websites.';
  }
  if (publishedPort(binding) === null) {
    return 'This port has no fixed port on the server for nginx to forward to.';
  }
  const address = bindingAddress(binding);
  if (address !== 'This server only' && address !== 'Every address') {
    return `It listens on ${address} only, and nginx forwards to 127.0.0.1.`;
  }
  return null;
}

/** A guess at where an app's healthcheck lives, for the Monitoring add dialog to start from. */
export interface AppHealthAddress {
  url: string;
  /** Plain http to another machine, which the check has to be allowed to call. */
  insecure: boolean;
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * The app's address with the healthcheck path on it. A domain from Websites comes first (https
 * when its site has a certificate), then a port published on the server's own address. Null
 * when every port stays on the server, so there is nothing outside to call.
 */
export function appHealthUrl(
  details: Pick<StackDetails, 'services'>,
  sites: readonly SiteInfo[] | undefined,
  serverHost: string,
): AppHealthAddress | null {
  const tcp = details.services
    .flatMap((service) => service.ports)
    .filter((port) => port.protocol.toLowerCase() !== 'udp');

  let plainDomain: string | null = null;
  for (const port of tcp) {
    const published = publishedPort(port);
    if (published === null) continue;
    for (const site of sites ?? []) {
      if (!forwardsTo(site, published)) continue;
      const domain = site.settings.domains.find((one) => one && !one.includes('*'));
      if (!domain) continue;
      if (site.certificate) {
        return { url: `https://${domain}${HEALTH_DEFAULT_PATH}`, insecure: false };
      }
      plainDomain ??= domain;
    }
  }
  if (plainDomain) return { url: `http://${plainDomain}${HEALTH_DEFAULT_PATH}`, insecure: true };

  const host = serverHost.trim();
  for (const port of tcp) {
    const published = publishedPort(port);
    if (published === null || !isPublicBinding(port)) continue;
    const address = bindingAddress(port) === 'Every address' ? host : (port.hostIp ?? host);
    if (!address) continue;
    const urlHost = hostForUrl(address);
    return {
      url: `http://${urlHost}:${published}${HEALTH_DEFAULT_PATH}`,
      insecure: !LOOPBACK_HOSTS.has(urlHost.toLowerCase()),
    };
  }
  return null;
}
