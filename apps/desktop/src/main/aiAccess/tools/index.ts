import type { AiTool } from '../registry';
import { apiClientTools } from './apiClient';
import { cloudflareTools } from './cloudflare';
import { databaseTools } from './database';
import { deployTools } from './deploy';
import { dockerTools } from './docker';
import { environmentTools } from './environments';
import { errorTrackingTools } from './errorTracking';
import { gitTools } from './git';
import { healthTools } from './health';
import { packageTools } from './packages';
import { pipelineTools } from './pipelines';
import { projectTools } from './projects';
import { promptTools } from './prompts';
import { relayTools } from './relay';
import { remoteTools } from './remote';
import { runovaTools } from './runova';
import { securityTools } from './security';
import { skillTools } from './skills';
import { sshTools } from './ssh';
import { studioTools } from './studio';
import { taskTools } from './tasks';
import { testTools } from './tests';
import { vaultTools } from './vault';
import { wordpressTools } from './wordpress';

/** Every tool Runova offers agents, area by area. A new area adds its list here. */
export function allAiTools(): AiTool[] {
  return [
    ...runovaTools,
    ...projectTools,
    ...environmentTools,
    ...apiClientTools,
    ...gitTools,
    ...dockerTools,
    ...taskTools,
    ...healthTools,
    ...databaseTools,
    ...pipelineTools,
    ...skillTools,
    ...promptTools,
    ...packageTools,
    ...securityTools,
    ...testTools,
    ...errorTrackingTools,
    ...deployTools,
    ...cloudflareTools,
    ...wordpressTools,
    ...sshTools,
    ...remoteTools,
    ...vaultTools,
    ...studioTools,
    ...relayTools,
  ];
}
