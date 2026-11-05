import { useProjectCleanupStore } from '@/stores/projectCleanupStore';
import { isCancelled, runScan } from './runCleanup';

export interface ScanAllOutcome {
  /** Projects looked at, the ones that failed included. */
  done: number;
  failed: number;
  cancelled: boolean;
}

/**
 * Scans the projects one at a time, so a long list never has several disks walks going at once,
 * and keeps each result for the Projects page. One project that cannot be scanned (it was just
 * removed, its folder is gone) is counted and skipped; it does not stop the rest.
 */
export async function scanAllProjects(
  projectIds: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<ScanAllOutcome> {
  const store = useProjectCleanupStore.getState();
  if (store.bulk.running || projectIds.length === 0) {
    return { done: 0, failed: 0, cancelled: false };
  }

  store.beginBulk(projectIds.length);
  let done = 0;
  let failed = 0;
  let cancelled = false;
  try {
    for (const projectId of projectIds) {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      useProjectCleanupStore.getState().stepBulk({ current: projectId });
      try {
        const scan = await runScan(projectId, { signal: options.signal });
        useProjectCleanupStore.getState().recordScan(projectId, scan);
      } catch (error) {
        if (isCancelled(error)) {
          cancelled = true;
          break;
        }
        failed += 1;
      }
      done += 1;
      useProjectCleanupStore.getState().stepBulk({ done, failed });
    }
  } finally {
    useProjectCleanupStore.getState().endBulk();
  }
  return { done, failed, cancelled };
}
