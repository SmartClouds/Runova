import { formatBytes } from '@runova/protocol';
import type { CloneJob } from '@shared/apiTypes';

/**
 * Words for a background clone, shared by the project card, the Git tab, the status bar and the
 * toasts so a clone is called the same thing everywhere it shows up.
 */

/**
 * Where main's progress moves from one git phase to the next (GitHub preparing, downloading,
 * unpacking, writing files). The bar draws a faint notch at each, so it shows which step is on.
 */
export const PHASE_MARKS = [10, 75, 92] as const;

export function clonePhaseLabel(job: CloneJob): string {
  switch (job.status) {
    case 'succeeded':
      return job.attach ? 'Connected' : 'Cloned';
    case 'failed':
      return 'Clone failed';
    case 'cancelled':
      return 'Stopped';
    default:
      break;
  }
  switch (job.phase) {
    case 'remote':
      return 'Preparing on GitHub';
    case 'receiving':
      return 'Downloading';
    case 'resolving':
      return 'Unpacking';
    case 'checkout':
      return job.attach ? 'Finishing' : 'Writing files';
    default:
      return 'Contacting GitHub';
  }
}

/** "12.0 MB · 2.0 MB/s" while a clone downloads, or null when there is nothing to show. */
export function cloneTransferText(job: CloneJob): string | null {
  if (job.status !== 'running' || !job.receivedBytes) return null;
  const size = formatBytes(job.receivedBytes);
  return job.bytesPerSecond ? `${size} · ${formatBytes(job.bytesPerSecond)}/s` : size;
}

/** One line that says how the clone went, for a toast title or a screen reader. */
export function cloneHeadline(job: CloneJob): string {
  switch (job.status) {
    case 'succeeded':
      return `${job.projectName} is ready`;
    case 'failed':
      return `Couldn't clone ${job.projectName}`;
    case 'cancelled':
      return `Stopped cloning ${job.projectName}`;
    default:
      return `Cloning ${job.projectName}`;
  }
}
