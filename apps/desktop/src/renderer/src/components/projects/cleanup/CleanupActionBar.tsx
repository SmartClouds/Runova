import { Spinner, Trash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Slides up from the bottom of the tab once something is picked. It says what the click will do
 * in numbers (how many, how much it frees) and puts the size on the button itself, so the
 * button is never just "Delete". While a deletion runs it turns into a progress bar and stays
 * put, so the person sees it finish instead of watching the list change.
 */

export interface CleanupActionBarProps {
  count: number;
  freeBytes: number;
  removing: boolean;
  progress: { done: number; total: number } | null;
  onDelete: () => void;
  onClear: () => void;
}

export function CleanupActionBar({
  count,
  freeBytes,
  removing,
  progress,
  onDelete,
  onClear,
}: CleanupActionBarProps): React.JSX.Element | null {
  if (count === 0 && !removing) return null;

  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;

  return (
    <section
      aria-label="Selected folders"
      className={cn(
        // Opaque, so the list scrolling underneath does not show through the text.
        'glass-opaque sticky bottom-3 z-10 mx-auto flex w-full max-w-2xl flex-wrap items-center gap-x-4 gap-y-2 rounded-full px-4 py-2.5',
        'shadow-[0_12px_32px_-12px_hsl(0_0%_0%/0.45)]',
        'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3',
      )}
    >
      {removing ? (
        <div className="min-w-0 flex-1 space-y-1.5">
          <p role="status" className="text-sm font-medium tabular-nums">
            {`${done} of ${total} deleted`}
          </p>
          <div
            role="progressbar"
            aria-label="Deleting"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            className="h-1 w-full overflow-hidden rounded-full bg-foreground/[0.08]"
          >
            <div
              className="h-full origin-left rounded-full bg-primary transition-transform duration-300 motion-reduce:transition-none"
              style={{ transform: `scaleX(${total === 0 ? 0 : done / total})` }}
            />
          </div>
        </div>
      ) : (
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium tabular-nums">
            {count === 1 ? '1 item selected' : `${count} items selected`}
          </p>
          <p className="text-xs text-muted-foreground">Frees {formatBytes(freeBytes)}</p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" disabled={removing} onClick={onClear}>
          Clear
        </Button>
        <Button size="sm" variant="destructive" disabled={removing} onClick={onDelete}>
          {removing ? (
            <>
              <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
              Deleting
            </>
          ) : (
            <>
              <Trash2 className="h-3.5 w-3.5" />
              Delete {formatBytes(freeBytes)}
            </>
          )}
        </Button>
      </div>
    </section>
  );
}
