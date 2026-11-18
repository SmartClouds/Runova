import { formatTokenCount } from '@runova/core';
import type { AgentContextUsage } from '@shared/apiTypes';

export type ContextLevel = 'calm' | 'warm' | 'hot';

/** From this share of the window the meter warms, so a full context never comes as a surprise. */
const WARM_SHARE = 0.6;
/** From this share it turns hot: time to wrap up or compact before Claude Code does it for you. */
const HOT_SHARE = 0.85;

function share(usage: AgentContextUsage): number {
  return usage.window > 0 ? usage.tokens / usage.window : 0;
}

/** How full the window is, as a whole percent between 0 and 100. */
export function contextPercent(usage: AgentContextUsage): number {
  return Math.min(100, Math.max(0, Math.round(share(usage) * 100)));
}

/** The percent as shown, with a sliver of use reading "<1%" rather than an empty-looking 0%. */
export function contextPercentLabel(usage: AgentContextUsage): string {
  const percent = contextPercent(usage);
  return percent === 0 && usage.tokens > 0 ? '<1%' : `${percent}%`;
}

export function contextLevel(usage: AgentContextUsage): ContextLevel {
  const used = share(usage);
  if (used >= HOT_SHARE) return 'hot';
  return used >= WARM_SHARE ? 'warm' : 'calm';
}

/** The token count the meter turns hot at, for the ring's guard mark. */
export function contextHotTokens(usage: AgentContextUsage): number {
  return Math.round(usage.window * HOT_SHARE);
}

/** `84.1K of 200K tokens used` */
export function contextUsedLabel(usage: AgentContextUsage): string {
  return `${formatTokenCount(usage.tokens)} of ${formatTokenCount(usage.window)} tokens used`;
}

/** `115.9K left` */
export function contextLeftLabel(usage: AgentContextUsage): string {
  return `${formatTokenCount(Math.max(0, usage.window - usage.tokens))} left`;
}
