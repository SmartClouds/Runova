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
 *
 * Its accessible name never repeats the project's name. The card already has a button with that
 * name, and a second one would make "click <project>" ambiguous for a voice command, a test
 * locator or a screen reader's list of buttons.
 */

export function ProjectStorageChip({
  projectId,
  onOpen,
  className,
}: {
  projectId: string;
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
          aria-label="Check how much space this project uses"
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
        aria-label={`This project uses ${total}, ${
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
