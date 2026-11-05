import { useId, useState } from 'react';
import { ChevronRight, cn } from '../kit';

export interface DaySectionProps {
  label: string;
  count: number;
  defaultOpen: boolean;
  /** What one item is called, for the count read out with the day ("3 changes"). */
  noun: [singular: string, plural: string];
  children: React.ReactNode;
}

/**
 * One day of a history list, folded under its date and count. A thin rail runs down the side of
 * the items with a dot per item, so the list reads as a timeline.
 */
export function DaySection({
  label,
  count,
  defaultOpen,
  noun,
  children,
}: DaySectionProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  const counted = `${count} ${count === 1 ? noun[0] : noun[1]}`;
  return (
    <div role="group" aria-label={label} className="pt-1 first:pt-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${label}, ${counted}`}
        onClick={() => setOpen((value) => !value)}
        className="group/day flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'h-2.5 w-2.5 shrink-0 transition-transform motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
        <span>{label}</span>
        <span className="ml-auto rounded-full bg-foreground/[0.06] px-1.5 tabular-nums">
          {count}
        </span>
      </button>
      {open && (
        <ol
          id={listId}
          className="relative space-y-0.5 before:absolute before:bottom-3 before:left-[13px] before:top-3 before:w-px before:bg-foreground/10"
        >
          {children}
        </ol>
      )}
    </div>
  );
}

/** The timeline dot of one item, tinted by who made the change. */
export function RailDot({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'absolute left-[10px] top-[11px] h-[7px] w-[7px] rounded-full ring-2 ring-background',
        className,
      )}
    />
  );
}
