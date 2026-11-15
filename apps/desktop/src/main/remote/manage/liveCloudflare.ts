import { liveDeployService } from '../../deploy/liveServices';
import type { ManageCloudflareDeps, ManageCloudflareService } from './cloudflareMethods';

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

export const liveCloudflare: ManageCloudflareDeps = {
  service,
  servers: async () =>
    (await liveDeployService('deploy').listServers())
      .filter((server) => !server.dev)
      .map((server) => ({ id: server.id, name: server.nickname })),
};
