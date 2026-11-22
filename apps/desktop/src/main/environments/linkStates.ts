import type { EnvFileLinkState } from '../../shared/apiTypes';

/**
 * How each linked env file is doing on this computer, by file id. The link manager and the
 * service's own writes set it; the Environments tab reads it through the file summaries. It lives
 * only in memory: every start looks at the files again.
 */

const states = new Map<string, EnvFileLinkState>();

/** A link nobody has looked at yet was just made or checked, so it counts as watched. */
export function envFileLinkState(fileId: string): EnvFileLinkState {
  return states.get(fileId) ?? 'watching';
}

export function setEnvFileLinkState(fileId: string, state: EnvFileLinkState | undefined): void {
  if (state) states.set(fileId, state);
  else states.delete(fileId);
}
