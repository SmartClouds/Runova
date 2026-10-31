import { EFFORT_LABELS, type EffortLevel } from '../promptBuilder/runRecommendation.js';
import { parseCliArgs } from './args.js';

/**
 * The slash commands that switch a running CLI's model or effort without restarting it. Only
 * CLIs that take the new value as an argument are listed: the others open an interactive picker
 * for `/model`, which a chat cannot drive.
 */
export interface CliLiveSwitch {
  model?: (model: string) => string;
  effort?: (effort: EffortLevel) => string;
}

const LIVE_SWITCHES: Record<string, CliLiveSwitch> = {
  'claude-code': {
    model: (model) => `/model ${model}`,
    effort: (effort) => `/effort ${effort}`,
  },
};

/** How to switch this CLI's model and effort mid-session, or null when it can't be done in place. */
export function cliLiveSwitch(cliId: string | null | undefined): CliLiveSwitch | null {
  return (cliId && LIVE_SWITCHES[cliId]) || null;
}

function isEffort(value: string | undefined): value is EffortLevel {
  return !!value && Object.hasOwn(EFFORT_LABELS, value);
}

/**
 * The effort a tab's launch command asked for (`--effort high` or `--effort=high`), so a tab can
 * show it before the CLI reports anything itself. Undefined when the command sets none.
 */
export function launchEffort(launchInput: string | null | undefined): EffortLevel | undefined {
  const args = parseCliArgs(launchInput?.trim());
  let found: EffortLevel | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value =
      arg === '--effort' ? args[i + 1] : arg.startsWith('--effort=') ? arg.slice(9) : null;
    // The last one wins, the same as the CLI's own parsing.
    if (value !== null && isEffort(value)) found = value;
  }
  return found;
}
