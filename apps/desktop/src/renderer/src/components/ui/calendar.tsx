import * as React from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from '@/components/icons';
import { cn } from '@/lib/utils';

/**
 * Days travel as `YYYY-MM-DD` strings, the same shape a native date input used, and all the
 * arithmetic runs in UTC so the machine's own time zone never shifts a day.
 */
export type Day = string;

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS_SHORT = Array.from({ length: 12 }, (_, month) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(
    Date.UTC(2000, month, 1),
  ),
);
const monthTitle = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const fullDay = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: 'UTC' });

export function parseDay(value: string | null | undefined): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Date.UTC rolls 2026-02-31 over into March, which is not the day that was asked for.
  return dayOf(ms) === value ? ms : null;
}

export function dayOf(ms: number): Day {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Today on this machine's own calendar. */
export function localToday(now = new Date()): Day {
  return dayOf(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function addMonths(ms: number, months: number): number {
  const date = new Date(ms);
  const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
  const lastDay = new Date(
    Date.UTC(new Date(target).getUTCFullYear(), new Date(target).getUTCMonth() + 1, 0),
  ).getUTCDate();
  return Date.UTC(
    new Date(target).getUTCFullYear(),
    new Date(target).getUTCMonth(),
    Math.min(date.getUTCDate(), lastDay),
  );
}

function monthStart(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

export interface CalendarProps {
  /** The picked day, ringed in the primary colour. */
  selected?: Day | null;
  /** The other end of a range this day belongs to, so the span between them is tinted. */
  rangeWith?: Day | null;
  onSelect: (day: Day) => void;
  /** Days outside these bounds are shown but can't be picked. */
  min?: Day | null;
  max?: Day | null;
  /** Which day counts as today, for a calendar that lives in another time zone. */
  today?: Day;
  /** Draws a Clear action in the footer. */
  onClear?: () => void;
  className?: string;
}

/** A month grid with a month and year jump view, drawn in the app's own colours. */
export function Calendar({
  selected,
  rangeWith,
  onSelect,
  min,
  max,
  today = localToday(),
  onClear,
  className,
}: CalendarProps): React.JSX.Element {
  const todayMs = parseDay(today) ?? parseDay(localToday())!;
  const selectedMs = parseDay(selected);
  const minMs = parseDay(min);
  const maxMs = parseDay(max);
  const [focused, setFocused] = React.useState<number>(() => selectedMs ?? todayMs);
  const [view, setView] = React.useState<'days' | 'months'>('days');
  const [yearShown, setYearShown] = React.useState(() => new Date(focused).getUTCFullYear());
  const gridRef = React.useRef<HTMLDivElement>(null);
  const moveFocus = React.useRef(false);

  const shownMonth = monthStart(focused);
  const shownDate = new Date(shownMonth);

  React.useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>('[data-focused="true"]')?.focus();
  });

  const disabled = (ms: number) => (minMs !== null && ms < minMs) || (maxMs !== null && ms > maxMs);

  const rangeMs = parseDay(rangeWith);
  const [low, high] =
    selectedMs !== null && rangeMs !== null
      ? [Math.min(selectedMs, rangeMs), Math.max(selectedMs, rangeMs)]
      : [null, null];

  // Six full weeks, starting on the Sunday on or before the 1st, so the grid never jumps height.
  const gridStart = shownMonth - shownDate.getUTCDay() * DAY_MS;
  const cells = Array.from({ length: 42 }, (_, index) => gridStart + index * DAY_MS);

  const go = (ms: number, keyboard = false) => {
    moveFocus.current = keyboard;
    setFocused(ms);
  };

  const onGridKey = (event: React.KeyboardEvent) => {
    const steps: Record<string, () => number> = {
      ArrowLeft: () => focused - DAY_MS,
      ArrowRight: () => focused + DAY_MS,
      ArrowUp: () => focused - 7 * DAY_MS,
      ArrowDown: () => focused + 7 * DAY_MS,
      Home: () => focused - new Date(focused).getUTCDay() * DAY_MS,
      End: () => focused + (6 - new Date(focused).getUTCDay()) * DAY_MS,
      PageUp: () => addMonths(focused, event.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focused, event.shiftKey ? 12 : 1),
    };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    go(step(), true);
  };

  const navButton =
    'flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30';

  if (view === 'months') {
    return (
      <div className={cn('w-64 select-none', className)}>
        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            aria-label="Previous year"
            className={navButton}
            onClick={() => setYearShown((year) => year - 1)}
          >
            <ChevronLeft className="h-3 w-3" />
          </button>
          <button
            type="button"
            aria-label="Back to days"
            className="cursor-pointer rounded-full px-3 py-1 text-sm font-semibold transition-colors hover:bg-foreground/10"
            onClick={() => setView('days')}
          >
            {yearShown}
          </button>
          <button
            type="button"
            aria-label="Next year"
            className={navButton}
            onClick={() => setYearShown((year) => year + 1)}
          >
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {MONTHS_SHORT.map((label, month) => {
            const start = Date.UTC(yearShown, month, 1);
            const end = Date.UTC(yearShown, month + 1, 0);
            const out = (maxMs !== null && start > maxMs) || (minMs !== null && end < minMs);
            const current =
              yearShown === shownDate.getUTCFullYear() && month === shownDate.getUTCMonth();
            return (
              <button
                key={label}
                type="button"
                disabled={out}
                aria-pressed={current}
                className={cn(
                  'h-10 cursor-pointer rounded-xl text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-30',
                  current
                    ? 'bg-primary font-semibold text-primary-foreground'
                    : 'hover:bg-foreground/10',
                )}
                onClick={() => {
                  go(
                    addMonths(
                      focused,
                      (yearShown - shownDate.getUTCFullYear()) * 12 +
                        month -
                        shownDate.getUTCMonth(),
                    ),
                  );
                  setView('days');
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const prevMonthEnd = shownMonth - DAY_MS;
  const nextMonthStart = addMonths(shownMonth, 1);

  return (
    <div className={cn('w-64 select-none', className)}>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label="Choose month and year"
          className="flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold transition-colors hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            setYearShown(shownDate.getUTCFullYear());
            setView('months');
          }}
        >
          {monthTitle.format(shownMonth)}
          <ChevronDown className="h-2.5 w-2.5 text-muted-foreground" />
        </button>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Previous month"
            className={navButton}
            disabled={minMs !== null && prevMonthEnd < minMs}
            onClick={() => go(addMonths(focused, -1))}
          >
            <ChevronLeft className="h-3 w-3" />
          </button>
          <button
            type="button"
            aria-label="Next month"
            className={navButton}
            disabled={maxMs !== null && nextMonthStart > maxMs}
            onClick={() => go(addMonths(focused, 1))}
          >
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div
        role="grid"
        aria-label={monthTitle.format(shownMonth)}
        onKeyDown={onGridKey}
        ref={gridRef}
      >
        <div role="row" className="mb-1 grid grid-cols-7">
          {WEEKDAYS.map((weekday) => (
            <span
              key={weekday}
              role="columnheader"
              className="text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70"
            >
              {weekday}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, week) => (
          <div role="row" key={week} className="grid grid-cols-7">
            {cells.slice(week * 7, week * 7 + 7).map((ms) => {
              const inMonth = new Date(ms).getUTCMonth() === shownDate.getUTCMonth();
              const isSelected = ms === selectedMs;
              const isEnd = ms === rangeMs;
              const inRange =
                low !== null && high !== null && ms >= low && ms <= high && low !== high;
              const isToday = ms === todayMs;
              const off = disabled(ms);
              return (
                <div
                  role="gridcell"
                  key={ms}
                  aria-selected={isSelected}
                  className={cn(
                    'flex h-8 items-center justify-center',
                    inRange && 'bg-primary/12',
                    inRange && ms === low && 'rounded-l-full',
                    inRange && ms === high && 'rounded-r-full',
                  )}
                >
                  <button
                    type="button"
                    tabIndex={ms === focused ? 0 : -1}
                    data-focused={ms === focused}
                    disabled={off}
                    aria-label={fullDay.format(ms)}
                    aria-current={isToday ? 'date' : undefined}
                    className={cn(
                      'relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-xs tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-25',
                      isSelected
                        ? 'bg-primary font-semibold text-primary-foreground shadow-[0_0_14px_-4px_hsl(var(--primary)/0.8)]'
                        : isEnd
                          ? 'bg-primary/25 font-semibold text-foreground'
                          : inMonth
                            ? 'text-foreground hover:bg-foreground/10'
                            : 'text-muted-foreground/45 hover:bg-foreground/10',
                      isToday && !isSelected && 'font-semibold text-primary',
                    )}
                    onClick={() => {
                      setFocused(ms);
                      onSelect(dayOf(ms));
                    }}
                  >
                    {new Date(ms).getUTCDate()}
                    {isToday && !isSelected && (
                      <span className="absolute bottom-1 h-1 w-1 rounded-full bg-primary" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between border-t border-foreground/10 pt-2">
        {onClear ? (
          <button
            type="button"
            className="cursor-pointer rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            onClick={onClear}
          >
            Clear
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          disabled={disabled(todayMs)}
          className="cursor-pointer rounded-full px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/12 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => {
            setFocused(todayMs);
            onSelect(dayOf(todayMs));
          }}
        >
          Today
        </button>
      </div>
    </div>
  );
}
