import type { AiAccessMode } from '@runova/core';
import type { AiToolRisk } from '../../shared/aiAccessTypes';

/**
 * Whether a call goes straight through or waits for the user. Full access never asks, the
 * sensitive mode asks before sensitive actions only, and the strictest mode asks before every
 * call. A tool the user allowed for the rest of a session goes through in any mode.
 */
export function decidePolicy({
  mode,
  risk,
  granted,
}: {
  mode: AiAccessMode;
  risk: AiToolRisk;
  granted: boolean;
}): 'allow' | 'ask' {
  if (granted) return 'allow';
  switch (mode) {
    case 'full':
      return 'allow';
    case 'sensitive':
      return risk === 'sensitive' ? 'ask' : 'allow';
    case 'all':
      return 'ask';
  }
}
