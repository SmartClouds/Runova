import { queryKeys } from '@/lib/queryKeys';

/** The fix prompt's query key, nested under the target so a change refreshes it too. */
export function healthFixPromptKey(targetId: string) {
  return [...queryKeys.healthTarget(targetId), 'fix-prompt'] as const;
}
