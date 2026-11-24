import { normalizeCloneUrl } from '@runova/core';
import type { StartCloneInput, StartCloneResult } from '@shared/apiTypes';
import { toast } from 'sonner';
import { GitBranch } from '@/components/icons';
import { startClone } from '@/stores/cloneJobsStore';
import { confirmDialog } from '@/stores/confirmStore';

/** `owner/repo` for a GitHub address, or a plain phrase when there is none to show. */
function repoName(repoUrl: string | undefined): string {
  const normalized = repoUrl ? normalizeCloneUrl(repoUrl) : null;
  return normalized ? normalized.replace(/^https:\/\/github\.com\//, '') : 'its GitHub repository';
}

/**
 * Starts a background clone the way every button in the app should: a folder that already has
 * files is connected only after the user agrees, and a clone that can't start says why. Once it
 * runs, the job's card, the status bar and the result toast take over.
 */
export async function runClone(input: StartCloneInput): Promise<StartCloneResult> {
  let result = await startClone(input);
  if (result.needsAttachConfirm && !input.attach) {
    const confirmed = await confirmDialog({
      title: `Connect this folder to ${repoName(input.repoUrl)}?`,
      description:
        'This folder already has files. They stay exactly as they are, and anything that differs from GitHub shows up as a change on the Git tab.',
      icon: GitBranch,
      confirmLabel: 'Connect',
    });
    if (!confirmed) return result;
    result = await startClone({ ...input, attach: true });
  }
  if (!result.ok) toast.error(result.message);
  else if (result.skipped) toast.info(result.message);
  return result;
}
