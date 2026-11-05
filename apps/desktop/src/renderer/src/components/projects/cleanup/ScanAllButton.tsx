import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { HardDrive, Spinner, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import { scanAllProjects } from '@/lib/projectCleanup/scanAll';
import { useProjectCleanupStore } from '@/stores/projectCleanupStore';

/**
 * "Check sizes" on the Projects page: scans the projects one after another so every card can show
 * what it takes up. It says how far along it is, can be stopped, and ends with one line that adds
 * up what could be freed across all of them.
 */

export function ScanAllButton({
  projectIds,
}: {
  projectIds: readonly string[];
}): React.JSX.Element {
  const bulk = useProjectCleanupStore((state) => state.bulk);
  const controller = useRef<AbortController | null>(null);

  // A scan that outlives the page would keep walking disks for a list nobody is looking at.
  useEffect(() => () => controller.current?.abort(), []);

  async function start(): Promise<void> {
    const abort = new AbortController();
    controller.current = abort;
    const startedAt = Date.now();
    const outcome = await scanAllProjects(projectIds, { signal: abort.signal });
    if (controller.current === abort) controller.current = null;
    if (outcome.cancelled || outcome.done === 0) return;

    const checked = outcome.done - outcome.failed;
    if (checked === 0) {
      toast.error('None of the projects could be checked.');
      return;
    }
    const summaries = useProjectCleanupStore.getState().summaries;
    const free = projectIds.reduce((sum, id) => {
      const summary = summaries[id];
      return summary && summary.scannedAt >= startedAt ? sum + summary.reclaimableBytes : sum;
    }, 0);
    const parts = [
      `Checked ${checked} ${checked === 1 ? 'project' : 'projects'}.`,
      free > 0 ? `About ${formatBytes(free)} can be freed.` : 'Nothing to free.',
    ];
    if (outcome.failed > 0) parts.push(`${outcome.failed} could not be checked.`);
    toast.success(parts.join(' '));
  }

  if (bulk.running) {
    return (
      <div className="search-pill flex h-9 shrink-0 items-center gap-1 rounded-full pl-3 pr-1 text-xs">
        <Spinner className="h-3.5 w-3.5 text-primary motion-safe:animate-spin" />
        <span role="status" className="tabular-nums text-muted-foreground">
          {`Checking ${Math.min(bulk.done + 1, bulk.total)} of ${bulk.total}`}
        </span>
        <SimpleTooltip label="Stop checking">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Stop checking"
            onClick={() => controller.current?.abort()}
          >
            <X />
          </Button>
        </SimpleTooltip>
      </div>
    );
  }

  return (
    <SimpleTooltip
      label="Scan every project to see how much space each one takes and how much of it could be freed"
      wrapTrigger
    >
      <Button
        variant="soft"
        className="h-9 shrink-0 font-medium"
        disabled={projectIds.length === 0}
        onClick={() => void start()}
      >
        <HardDrive className="h-4 w-4" />
        Check sizes
      </Button>
    </SimpleTooltip>
  );
}
