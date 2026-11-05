import { HardDrive } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import { shortAge } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useProjectCleanupStore } from '@/stores/projectCleanupStore';

/**
 * What a project takes up and how much of that could go, as one small button on its card or row.
 * It shows what the last scan found (nothing is scanned by looking at the Projects page), and
 * opens the project's Cleanup tab, where the details and the delete flow are.
 */

export function ProjectStorageChip({
  projectId,
  name,
  onOpen,
  className,
}: {
  projectId: string;
  name: string;
  onOpen: () => void;
  className?: string;
}): React.JSX.Element {
  const summary = useProjectCleanupStore((state) => state.summaries[projectId]);
  const checking = useProjectCleanupStore(
    (state) => state.bulk.running && state.bulk.current === projectId,
  );

  if (checking) {
    return (
      <Chip tone="primary" dot pulse className={className}>
        Checking
      </Chip>
    );
  }

  const open = (event: React.MouseEvent): void => {
    // The card around it opens the project; this opens the project's Cleanup tab instead.
    event.stopPropagation();
    onOpen();
  };
  const buttonClass = cn(
    'inline-flex cursor-pointer items-center gap-1 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    className,
  );

  if (!summary) {
    return (
      <SimpleTooltip label="Find out how much space this project takes up">
        <button
          type="button"
          aria-label={`Check how much space ${name} uses`}
          className={buttonClass}
          onClick={open}
        >
          <Chip className="transition-colors hover:bg-foreground/[0.1] hover:text-foreground">
            <HardDrive />
            Check size
          </Chip>
        </button>
      </SimpleTooltip>
    );
  }

  const total = formatBytes(summary.totalBytes);
  const free = formatBytes(summary.reclaimableBytes);
  const canFree = summary.reclaimableBytes > 0;
  return (
    <SimpleTooltip label={`Scanned ${shortAge(summary.scannedAt)} ago. Open Cleanup.`}>
      <button
        type="button"
        aria-label={`${name} uses ${total}, ${
          canFree ? `and ${free} of it can be freed` : 'and nothing in it can be freed'
        }. Open Cleanup.`}
        className={buttonClass}
        onClick={open}
      >
        <Chip className="transition-colors hover:bg-foreground/[0.1] hover:text-foreground">
          <HardDrive />
          {total}
        </Chip>
        {canFree && (
          <Chip tone="primary" className="transition-colors hover:bg-primary/20">
            {free} to free
          </Chip>
        )}
      </button>
    </SimpleTooltip>
  );
}
