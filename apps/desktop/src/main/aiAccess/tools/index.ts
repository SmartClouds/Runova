import type { AiTool } from '../registry';
import { runovaTools } from './runova';

/** Every tool Runova offers agents, area by area. A new area adds its list here. */
export function allAiTools(): AiTool[] {
  return [...runovaTools];
}
