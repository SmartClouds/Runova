import type { AiTool } from '../registry';
import { apiClientTools } from './apiClient';
import { dockerTools } from './docker';
import { environmentTools } from './environments';
import { gitTools } from './git';
import { healthTools } from './health';
import { pipelineTools } from './pipelines';
import { projectTools } from './projects';
import { runovaTools } from './runova';
import { taskTools } from './tasks';

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
    ...pipelineTools,
  ];
}
