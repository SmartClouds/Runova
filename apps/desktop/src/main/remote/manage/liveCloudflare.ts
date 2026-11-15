import { liveDeployService } from '../../deploy/liveServices';
import { publicIpAddress } from '../../ipc/ipGeo';
import type { ManageCloudflareDeps, ManageCloudflareService } from './cloudflareMethods';
import type { ManageCloudflareOriginDeps } from './cloudflareOriginMethods';

/**
 * The desktop's own Cloudflare service, looked up on each call, so a phone reaches the instance the
 * Cloudflare page uses once Deploy has made it, with the same saved tokens.
 */
const service = new Proxy({} as ManageCloudflareService, {
  get:
    (_, method: string) =>
    (...args: unknown[]) =>
      (liveDeployService('cloudflare') as unknown as Record<string, (...a: unknown[]) => unknown>)[
        method
      ](...args),
});

/** The running email code gate, looked up on each call like the service. */
const emailGate: ManageCloudflareDeps['emailGate'] = {
  plan: (zoneId) => liveDeployService('cloudflareEmailGate').plan(zoneId),
  prepare: (input) => liveDeployService('cloudflareEmailGate').prepare(input),
  save: (input) => liveDeployService('cloudflareEmailGate').save(input),
  remove: (target) => liveDeployService('cloudflareEmailGate').remove(target),
  letThisComputerThrough: (target) =>
    liveDeployService('cloudflareEmailGate').letThisComputerThrough(target),
  proxy: (target) => liveDeployService('cloudflareEmailGate').proxy(target),
};

export const liveCloudflare: ManageCloudflareDeps = {
  service,
  emailGate,
  publicIp: publicIpAddress,
  serverOps: {
    dnsTokens: (id) => liveDeployService('cloudflareServer').dnsTokens(id),
    provisionDnsToken: (input) => liveDeployService('cloudflareServer').provisionDnsToken(input),
    removeDnsToken: (input) => liveDeployService('cloudflareServer').removeDnsToken(input),
  },
  servers: async () =>
    (await liveDeployService('deploy').listServers())
      .filter((server) => !server.dev)
      .map((server) => ({ id: server.id, name: server.nickname })),
};

/** A method of a live op looked up on each call, as the service is above. */
function lateBound<T extends object>(key: 'cloudflareServer' | 'cloudflareTunnel'): T {
  return new Proxy({} as T, {
    get:
      (_, method: string) =>
      (...args: unknown[]) =>
        (liveDeployService(key) as unknown as Record<string, (...a: unknown[]) => unknown>)[method](
          ...args,
        ),
  });
}

/** A server's Cloudflare-only origin (E102), through the ops and firewall the Deploy page uses. */
export const liveCloudflareOrigin: ManageCloudflareOriginDeps = {
  access: (id) => liveDeployService('deploy').access(id),
  firewallPending: async (id) => (await liveDeployService('firewall').status(id)).pending ?? null,
  keep: (input) => liveDeployService('firewall').confirm(input),
  revert: (input) => liveDeployService('firewall').revert(input),
  lock: lateBound('cloudflareServer'),
  tunnel: lateBound('cloudflareTunnel'),
};
