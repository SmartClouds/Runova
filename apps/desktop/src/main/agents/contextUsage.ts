import type { AgentContextUsage } from '../../shared/apiTypes';
import { contextWindowFor, readContextTokens } from '../relay/contextMeter';
import { agentStatus } from './statusTracker';

const STANDARD_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

/**
 * Puts a token count against the window of the model that produced it. Transcripts record the
 * model id without its `[1m]` suffix, so a context already past the standard window can only
 * be a 1M session, and is measured as one rather than shown over 100%.
 */
export function contextUsageFor(tokens: number, model: string | undefined): AgentContextUsage {
  const window = contextWindowFor(model) ?? STANDARD_WINDOW;
  return { tokens, window: tokens > window ? LARGE_WINDOW : window };
}

/**
 * How full a workspace tab's Claude Code session is right now. Null until the session has
 * reported its transcript through the hooks and Claude has replied at least once.
 */
export async function readSessionContextUsage(
  sessionId: string,
): Promise<AgentContextUsage | null> {
  const path = agentStatus.transcriptPath(sessionId);
  if (!path) return null;
  const tokens = await readContextTokens(path);
  if (tokens === null) return null;
  return contextUsageFor(tokens, agentStatus.model(sessionId));
}
