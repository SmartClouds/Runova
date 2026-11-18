import { useMemo, useState } from 'react';
import { niceMax } from '@/lib/deploy/traffic/geometry';
import { cn } from '@/lib/utils';

/**
 * Stacked columns over time (E109, E110): one column a bucket, its parts stacked from the baseline
 * with a 2px surface gap between them, the top end rounded and the baseline square, never wider
 * than 24px. Each column is its own hit target with a readout of every part, and the arrow keys
 * walk the columns with the same readout.
 */

export interface StackSeries {
  key: string;
  label: string;
  color: string;
}

export function StackedColumns({
  title,
  times,
  columns,
  series,
  formatValue,
  bucketLabel,
  axisLabel,
  height = 120,
}: {
  title: string;
  times: number[];
  /** One entry a bucket, its parts in the order of `series`, the first at the bottom. */
  columns: number[][];
  series: StackSeries[];
  formatValue: (value: number) => string;
  bucketLabel: (unixMs: number) => string;
  axisLabel: (unixMs: number) => string;
  height?: number;
}): React.JSX.Element {
  const [index, setIndex] = useState<number | null>(null);
  const n = times.length;
  const max = useMemo(
    () => niceMax(Math.max(0, ...columns.map((parts) => parts.reduce((a, b) => a + b, 0)))),
    [columns],
  );
  const totals = series.map((_, part) =>
    columns.reduce((sum, parts) => sum + (parts[part] ?? 0), 0),
  );
  const summary =
    n === 0
      ? `${title}: nothing in this range`
      : `${title}, ${n} buckets from ${bucketLabel(times[0])} to ${bucketLabel(times[n - 1])}. In all: ${series
          .map((item, part) => `${item.label} ${formatValue(totals[part])}`)
          .join(', ')}.`;

  function onKeyDown(event: React.KeyboardEvent): void {
    if (n === 0) return;
    const current = index ?? n - 1;
    const moves: Record<string, number> = {
      ArrowLeft: Math.max(0, current - 1),
      ArrowRight: Math.min(n - 1, current + 1),
      Home: 0,
      End: n - 1,
    };
    if (event.key === 'Escape') {
      setIndex(null);
      return;
    }
    if (!(event.key in moves)) return;
    event.preventDefault();
    setIndex(moves[event.key]);
  }

  const shown = index !== null && index < n ? index : null;
  const leftPct = shown === null ? 0 : ((shown + 0.5) / Math.max(1, n)) * 100;

  return (
    <figure className="min-w-0" aria-label={title}>
      <div
        role="img"
        aria-label={summary}
        tabIndex={0}
        className="relative flex items-end gap-[2px] rounded-sm shadow-[inset_0_-1px_0_hsl(var(--border))] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ height }}
        onKeyDown={onKeyDown}
        onBlur={() => setIndex(null)}
        onPointerLeave={() => setIndex(null)}
      >
        {columns.map((parts, column) => {
          const sum = parts.reduce((a, b) => a + b, 0);
          return (
            <div
              key={times[column]}
              data-column
              className={cn(
                'flex h-full min-w-0 flex-1 items-end justify-center rounded-sm',
                shown === column && 'bg-foreground/[0.05]',
              )}
              onPointerEnter={() => setIndex(column)}
            >
              <div
                className="flex w-full max-w-6 flex-col-reverse gap-[2px]"
                style={{ height: `${(sum / max) * 100}%` }}
              >
                {parts.map((value, part) =>
                  value > 0 ? (
                    <div
                      key={series[part]?.key ?? part}
                      className="min-h-px w-full last:rounded-t-[4px]"
                      style={{
                        flexGrow: value,
                        flexBasis: 0,
                        backgroundColor: series[part]?.color,
                      }}
                    />
                  ) : null,
                )}
              </div>
            </div>
          );
        })}
        {shown !== null && (
          <div
            role="tooltip"
            className="pointer-events-none absolute top-1 z-10 min-w-max rounded-lg border border-border bg-popover px-2.5 py-2 text-xs shadow-md"
            style={
              leftPct > 60
                ? { right: `calc(${100 - leftPct}% + 10px)` }
                : { left: `calc(${leftPct}% + 10px)` }
            }
          >
            <div className="mb-1 text-[10px] text-muted-foreground">
              {bucketLabel(times[shown])}
            </div>
            {series.map((item, part) => (
              <div key={item.key} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-[2px]"
                  style={{ backgroundColor: item.color }}
                />
                <span className="font-semibold text-popover-foreground">
                  {formatValue(columns[shown]?.[part] ?? 0)}
                </span>
                <span className="text-muted-foreground">{item.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div
        className="mt-1.5 flex justify-between text-[10px] tabular-nums text-muted-foreground"
        aria-hidden
      >
        <span>{n > 0 ? axisLabel(times[0]) : ''}</span>
        <span>{n > 1 ? axisLabel(times[n - 1]) : ''}</span>
      </div>
      <ul
        className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
        aria-label="Legend"
      >
        {series.map((item, part) => (
          <li key={item.key} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ backgroundColor: item.color }}
            />
            {item.label}
            <span className="font-medium tabular-nums text-foreground/80">
              {formatValue(totals[part])}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
