import { useMemo, useState } from 'react';
import { areaPath, linePath, niceMax } from '@/lib/deploy/traffic/geometry';
import { cn } from '@/lib/utils';

/**
 * The traffic report's line chart (E109), a sibling of the Overview's MetricChart with the same
 * rules: one axis, 2px lines over a 10% wash, solid hairline grid, end dots ringed in the card
 * colour, a crosshair that snaps to the nearest bucket and the same readout on the arrow keys. What
 * it adds is the period before, drawn dashed and faint behind each line, bucket for bucket.
 */

export interface TimeSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
  /** The same measure for the period before, aligned bucket for bucket; null where it was not counted. */
  previous?: (number | null)[];
}

const WIDTH = 600;

export function TimeChart({
  title,
  times,
  series,
  formatValue,
  formatTick,
  bucketLabel,
  axisLabel,
  previousLabel,
  height = 200,
}: {
  title: string;
  times: number[];
  series: TimeSeries[];
  formatValue: (value: number) => string;
  formatTick: (value: number) => string;
  /** The bucket in full, for the readout. */
  bucketLabel: (unixMs: number) => string;
  /** The bucket on the axis. */
  axisLabel: (unixMs: number) => string;
  previousLabel: string;
  height?: number;
}): React.JSX.Element {
  const [index, setIndex] = useState<number | null>(null);
  const n = times.length;

  const geometry = useMemo(() => {
    const all = series.flatMap((item) => [
      ...item.values,
      ...(item.previous ?? []).filter((value): value is number => value !== null),
    ]);
    const max = niceMax(Math.max(0, ...all));
    return {
      max,
      lines: series.map((item) => ({
        key: item.key,
        color: item.color,
        line: linePath(item.values, WIDTH, height, max),
        area: areaPath(item.values, WIDTH, height, max),
        previous: item.previous ? linePath(item.previous, WIDTH, height, max) : null,
      })),
    };
  }, [series, height]);

  const x = (i: number) => (n <= 1 ? WIDTH : (i / (n - 1)) * WIDTH);
  const yPct = (value: number) => (1 - Math.min(1, value / geometry.max)) * 100;
  const ticks = [geometry.max, geometry.max / 2, 0];
  const summary =
    n === 0
      ? `${title}: nothing in this range`
      : `${title}, ${n} buckets from ${bucketLabel(times[0])} to ${bucketLabel(times[n - 1])}. ${series
          .map(
            (item) =>
              `${item.label} in all: ${formatValue(item.values.reduce((a, b) => a + b, 0))}`,
          )
          .join(', ')}.`;

  function pick(clientX: number, target: HTMLElement): void {
    if (n === 0) return;
    const rect = target.getBoundingClientRect();
    const share = (clientX - rect.left) / Math.max(1, rect.width);
    setIndex(Math.min(n - 1, Math.max(0, Math.round(share * (n - 1)))));
  }

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
  const leftPct = shown === null ? 0 : (x(shown) / WIDTH) * 100;
  const at = shown ?? n - 1;

  return (
    <figure className="min-w-0" aria-label={title}>
      <div className="flex gap-2">
        <div
          className="flex shrink-0 flex-col justify-between text-right text-[10px] tabular-nums text-muted-foreground"
          style={{ height }}
          aria-hidden
        >
          {ticks.map((tick) => (
            <span key={tick} className="-my-1 leading-none">
              {formatTick(tick)}
            </span>
          ))}
        </div>
        <div
          role="img"
          aria-label={summary}
          tabIndex={0}
          className="relative min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ height }}
          onPointerMove={(event) => pick(event.clientX, event.currentTarget)}
          onPointerLeave={() => setIndex(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setIndex(null)}
        >
          <svg
            viewBox={`0 0 ${WIDTH} ${height}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible"
            aria-hidden
          >
            {ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={WIDTH}
                y1={(yPct(tick) / 100) * height}
                y2={(yPct(tick) / 100) * height}
                stroke="hsl(var(--border))"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {geometry.lines.map(
              (line) =>
                line.previous && (
                  <path
                    key={`p-${line.key}`}
                    data-previous={line.key}
                    d={line.previous}
                    fill="none"
                    stroke={line.color}
                    strokeOpacity={0.45}
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ),
            )}
            {geometry.lines.map((line) => (
              <path key={`a-${line.key}`} d={line.area} fill={line.color} fillOpacity={0.1} />
            ))}
            {geometry.lines.map((line) => (
              <path
                key={`l-${line.key}`}
                data-series={line.key}
                d={line.line}
                fill="none"
                stroke={line.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {shown !== null && (
              <line
                x1={x(shown)}
                x2={x(shown)}
                y1={0}
                y2={height}
                stroke="hsl(var(--muted-foreground) / 0.5)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {n > 0 &&
            series.map((item) => (
              <span
                key={`d-${item.key}`}
                className="pointer-events-none absolute h-2.5 w-2.5 rounded-full border-2"
                style={{
                  left: `${(x(at) / WIDTH) * 100}%`,
                  top: `${yPct(item.values[at] ?? 0)}%`,
                  transform: 'translate(-50%, -50%)',
                  backgroundColor: item.color,
                  borderColor: 'hsl(var(--card))',
                }}
              />
            ))}
          {shown !== null && (
            <div
              role="tooltip"
              className="pointer-events-none absolute top-1 z-10 min-w-max rounded-lg border border-border bg-popover px-2.5 py-2 text-xs shadow-md"
              style={
                leftPct > 60
                  ? { right: `calc(${100 - leftPct}% + 12px)` }
                  : { left: `calc(${leftPct}% + 12px)` }
              }
            >
              <div className="mb-1 text-[10px] text-muted-foreground">
                {bucketLabel(times[shown])}
              </div>
              {series.map((item) => (
                <div key={item.key} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-0.5 w-3 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="font-semibold text-popover-foreground">
                    {formatValue(item.values[shown] ?? 0)}
                  </span>
                  <span className="text-muted-foreground">{item.label}</span>
                  {item.previous && item.previous[shown] != null && (
                    <span className="text-muted-foreground">
                      ({formatValue(item.previous[shown] ?? 0)} {previousLabel.toLowerCase()})
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div
        className={cn(
          'mt-1.5 flex justify-between pl-10 text-[10px] tabular-nums text-muted-foreground',
        )}
        aria-hidden
      >
        <span>{n > 0 ? axisLabel(times[0]) : ''}</span>
        <span>{n > 2 ? axisLabel(times[Math.floor((n - 1) / 2)]) : ''}</span>
        <span>{n > 1 ? axisLabel(times[n - 1]) : ''}</span>
      </div>
    </figure>
  );
}

/** Line keys under a chart: each series, and the period before as a dashed key. */
export function ChartLegend({
  series,
  previousLabel,
}: {
  series: Array<{ key: string; label: string; color: string }>;
  previousLabel?: string;
}): React.JSX.Element {
  return (
    <ul
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
      aria-label="Legend"
    >
      {series.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-3 rounded-full"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </li>
      ))}
      {previousLabel && (
        <li className="flex items-center gap-1.5">
          <svg width="14" height="2" aria-hidden className="overflow-visible">
            <line
              x1="0"
              x2="14"
              y1="1"
              y2="1"
              stroke="hsl(var(--muted-foreground))"
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
          </svg>
          {previousLabel}
        </li>
      )}
    </ul>
  );
}
