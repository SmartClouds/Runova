import { useId } from 'react';
import type { DayBar } from '@/lib/account/monitoring';
import { cn } from '@/lib/utils';

/**
 * The Monitoring page's small charts (E57): the uptime strip of a card, its latency line, and the
 * drawer's response time chart. Each one says what it shows in words too, so nothing rests on
 * color or on seeing the shape.
 */

const BAR_TONES: Record<DayBar['tone'], string> = {
  success: 'bg-success/80',
  warning: 'bg-warning/85',
  danger: 'bg-destructive/85',
  none: 'bg-foreground/[0.09]',
};

/** One bar a day, oldest on the left; a tooltip and a screen reader say each day's share. */
export function UptimeBars({ bars, label }: { bars: DayBar[]; label: string }) {
  const failed = bars.filter((bar) => bar.tone === 'danger').length;
  return (
    <div>
      <ul aria-label={label} className="flex h-7 min-w-0 items-stretch gap-px sm:gap-[2px]">
        {bars.map((bar) => (
          <li
            key={bar.start}
            title={bar.label}
            aria-label={bar.label}
            className={cn('min-w-0 flex-1 rounded-full', BAR_TONES[bar.tone])}
          />
        ))}
      </ul>
      <p className="mt-1 flex justify-between text-[0.7rem] text-muted-foreground">
        <span>{bars.length} days ago</span>
        <span>
          {failed === 0
            ? 'No down days'
            : `${failed} ${failed === 1 ? 'day' : 'days'} with failures`}
        </span>
        <span>Today</span>
      </p>
    </div>
  );
}

/** Points to an SVG path, with a break wherever a value is missing. */
function path(points: { x: number; y: number | null }[]): string {
  let d = '';
  let open = false;
  for (const point of points) {
    if (point.y === null) {
      open = false;
      continue;
    }
    d += `${open ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
    open = true;
  }
  return d;
}

/** A small latency line for a card: the last day's hourly averages. */
export function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const width = 120;
  const height = 28;
  const known = values.filter((value): value is number => value !== null);
  if (known.length < 2) {
    return (
      <span className="text-[0.7rem] text-muted-foreground" role="img" aria-label={label}>
        Not enough checks for a line yet
      </span>
    );
  }
  const max = Math.max(...known);
  const min = Math.min(...known);
  const span = Math.max(1, max - min);
  const step = width / Math.max(1, values.length - 1);
  const points = values.map((value, index) => ({
    x: index * step,
    y: value === null ? null : height - 3 - ((value - min) / span) * (height - 6),
  }));
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-7 w-28 overflow-visible text-primary"
      role="img"
      aria-label={label}
    >
      <path
        d={path(points)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface ChartPoint {
  at: number;
  value: number | null;
  /** A check that found the monitor down, drawn as a mark on the floor. */
  failed?: boolean;
}

const TIME = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' });
const DATE = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });

/**
 * The drawer's response time chart: a line over the range, a soft area under it, failed checks as
 * red ticks on the floor, and the highest and lowest value named on the axis.
 */
export function LatencyChart({
  points,
  from,
  to,
  label,
}: {
  points: ChartPoint[];
  from: number;
  to: number;
  label: string;
}) {
  const gradient = useId();
  const width = 560;
  const height = 160;
  const pad = { top: 12, right: 8, bottom: 22, left: 44 };
  const known = points
    .map((point) => point.value)
    .filter((value): value is number => value !== null);
  const max = known.length > 0 ? Math.max(...known) : 0;
  const top = max <= 0 ? 100 : Math.ceil((max * 1.15) / 10) * 10;
  const span = Math.max(1, to - from);
  const x = (at: number) => pad.left + ((at - from) / span) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + (1 - value / top) * (height - pad.top - pad.bottom);
  const line = path(
    points.map((point) => ({ x: x(point.at), y: point.value === null ? null : y(point.value) })),
  );
  const sameDay = span <= 86_400_000;
  const tick = (at: number) => (sameDay ? TIME.format(at) : DATE.format(at));
  const average =
    known.length > 0 ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null;
  const failures = points.filter((point) => point.failed).length;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={label}
      >
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.28" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((share) => (
          <g key={share}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(top * share)}
              y2={y(top * share)}
              stroke="hsl(var(--foreground) / 0.08)"
              strokeDasharray={share === 0 ? undefined : '3 4'}
            />
            <text
              x={pad.left - 6}
              y={y(top * share) + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[10px]"
            >
              {Math.round(top * share)} ms
            </text>
          </g>
        ))}
        {line && (
          <>
            <path
              d={`${line}L${x(to).toFixed(1)},${y(0).toFixed(1)}L${x(from).toFixed(1)},${y(0).toFixed(1)}Z`}
              fill={`url(#${gradient})`}
              stroke="none"
              opacity="0.9"
            />
            <path
              d={line}
              fill="none"
              stroke="hsl(var(--primary))"
              strokeWidth="1.75"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </>
        )}
        {points
          .filter((point) => point.failed)
          .map((point) => (
            <rect
              key={`f-${point.at}`}
              x={x(point.at) - 1}
              y={y(0) - 6}
              width="2"
              height="6"
              rx="1"
              fill="hsl(var(--destructive))"
            />
          ))}
        <text x={pad.left} y={height - 6} className="fill-muted-foreground text-[10px]">
          {tick(from)}
        </text>
        <text
          x={width - pad.right}
          y={height - 6}
          textAnchor="end"
          className="fill-muted-foreground text-[10px]"
        >
          {tick(to)}
        </text>
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
        <span>
          Average{' '}
          <span className="font-medium text-foreground tabular-nums">
            {average === null ? 'none' : `${average} ms`}
          </span>
        </span>
        <span>
          Highest{' '}
          <span className="font-medium text-foreground tabular-nums">
            {known.length > 0 ? `${Math.round(max)} ms` : 'none'}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-0.5 rounded-full bg-destructive" />
          {failures === 0
            ? 'No failed checks'
            : `${failures} failed ${failures === 1 ? 'check' : 'checks'}`}
        </span>
      </figcaption>
    </figure>
  );
}
