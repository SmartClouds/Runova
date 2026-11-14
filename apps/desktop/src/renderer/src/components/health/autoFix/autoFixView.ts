import {
  type CliLaunchOptions,
  cliLaunchOptions,
  type EffortLevel,
  launchPickLabel,
} from '@runova/core';
import type { DeployAssistantContextInput } from '@shared/deployAssistantTypes';
import type { HealthAppLink, HealthTargetSummary } from '@shared/healthTypes';
import { HEALTH_STATE_META, healthBucket } from '../healthView';

/**
 * Monitoring's Auto fix: what is worked out without drawing anything. The flags a Workspace
 * terminal starts the agent with, the label its tab shows, and where a monitor's Deploy app is.
 */

/** A CLI, and the model, effort and permission mode to start it with. Unset adds no flag. */
export interface WorkspacePick {
  cliId: string;
  model?: string;
  effort?: EffortLevel;
  /** Id of one of the CLI's launch modes. Unset keeps the mode set in Settings, if any. */
  mode?: string;
}

/** Only a monitor with something wrong has anything to fix. */
export function canAutoFix(target: Pick<HealthTargetSummary, 'state'>): boolean {
  const bucket = healthBucket(target.state);
  return bucket === 'down' || bucket === 'degraded';
}

function effortFits(
  options: CliLaunchOptions,
  model: string | undefined,
  effort: EffortLevel,
): boolean {
  const known = options.models.find((one) => one.value === model);
  return options.efforts.includes(effort) && (!known || !!known.efforts?.includes(effort));
}

/**
 * The flags for one Workspace run: the model, then the effort when that model takes it, then the
 * permission mode. A mode set here wins over the one saved in Settings, which the launch then
 * leaves out.
 */
export function workspaceRunArgs(pick: WorkspacePick): string[] {
  const options = cliLaunchOptions(pick.cliId);
  if (!options) return [];
  const args: string[] = [];
  const model = pick.model?.trim() || undefined;
  if (model && options.modelFlag) args.push(options.modelFlag, model);
  if (pick.effort && options.effortArgs && effortFits(options, model, pick.effort)) {
    args.push(...options.effortArgs(pick.effort));
  }
  const mode = options.modes.find((one) => one.id === pick.mode);
  if (mode) args.push(...mode.args);
  return args;
}

/** The pick in words for the tab, like "Opus 5.5 · High · Accept edits". */
export function workspaceRunLabel(pick: WorkspacePick): string | undefined {
  const mode = cliLaunchOptions(pick.cliId)?.modes.find((one) => one.id === pick.mode);
  const parts = [
    launchPickLabel(pick.cliId, { model: pick.model, effort: pick.effort }),
    mode?.label,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** The app's page on the Deploy screen, where the Deploy AI already knows the app. */
export function deployAppRoute(link: HealthAppLink): string {
  return `/deploy?${new URLSearchParams({ server: link.serverId, view: 'apps', app: link.stackId }).toString()}`;
}

/** What the Deploy AI drawer shows it was pointed at, and is told along with the prompt. */
export function deployContext(
  target: Pick<HealthTargetSummary, 'name' | 'state' | 'url' | 'headline'>,
): DeployAssistantContextInput {
  return {
    title: `${HEALTH_STATE_META[target.state].label}: ${target.name}`,
    facts: [`Monitored at ${target.url}`, ...(target.headline ? [target.headline] : [])],
  };
}
