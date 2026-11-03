import type { CloudflareService } from './cloudflare/service';
import type { DeployDocker } from './docker';
import type { DeployService } from './service';
import type { DeploySites } from './sites/deploySites';
import type { DeployStacks } from './stacks/service';
import type { WordPressProjectService } from './wordpress/projectService';

/**
 * The Deploy services the app runs on, kept once the wiring has made them, so the AI access tools
 * call the very same instances the IPC handlers call rather than making their own. Nothing here
 * holds a secret of its own; each service keeps its secrets sealed as before.
 */

export interface LiveDeployServices {
  deploy: DeployService;
  stacks: DeployStacks;
  sites: DeploySites;
  docker: DeployDocker;
  cloudflare: CloudflareService;
  wordpress: WordPressProjectService;
}

const live: Partial<LiveDeployServices> = {};

export function setLiveDeployServices(services: Partial<LiveDeployServices>): void {
  Object.assign(live, services);
}

export function liveDeployService<K extends keyof LiveDeployServices>(
  key: K,
): LiveDeployServices[K] {
  const service = live[key];
  if (!service) throw new Error('Deploy has not started yet. Try again in a moment.');
  return service as LiveDeployServices[K];
}
