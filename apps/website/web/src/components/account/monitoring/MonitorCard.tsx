import { CircleAlert, CircleCheck, CircleDashed, CirclePause, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { apiRequest } from '@/lib/account/api';
import {
  type CloudMonitor,
  dailyBars,
  formatLatency,
  formatUptime,
  type MonitorHour,
  type Verdict,
  verdictLabel,
} from '@/lib/account/monitoring';
import { cn } from '@/lib/utils';
import { relativeTime } from '../ui';
import { Sparkline, UptimeBars } from './charts';

export const UPTIME_DAYS = 90;
const DAY_MS = 86_400_000;

const VERDICT_STYLE: Record<Verdict, { dot: string; pill: string; Icon: typeof CircleCheck }> = {
  up: { dot: 'bg-success', pill: 'bg-success/12 text-success', Icon: CircleCheck },
  down: { dot: 'bg-destructive', pill: 'bg-destructive/12 text-destructive', Icon: CircleAlert },
  degraded: { dot: 'bg-warning', pill: 'bg-warning/14 text-warning', Icon: TriangleAlert },
  paused: {
    dot: 'bg-muted-foreground',
    pill: 'bg-foreground/[0.07] text-muted-foreground',
    Icon: CirclePause,
  },
  unknown: {
    dot: 'bg-foreground/30',
    pill: 'bg-foreground/[0.07] text-muted-foreground',
    Icon: CircleDashed,
  },
};

/** The status in words and an icon, never color alone. */
export function VerdictPill({ verdict }: { verdict: Verdict }) {
  const { pill, Icon } = VERDICT_STYLE[verdict];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-xs',
        pill,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {verdictLabel(verdict)}
    </span>
  );
}

/** The live dot: it breathes while the monitor is up and the page is live (still under reduced motion). */
export function StatusDot({ verdict, live }: { verdict: Verdict; live: boolean }) {
  const { dot } = VERDICT_STYLE[verdict];
  return (
    <span aria-hidden className="relative flex size-2.5 shrink-0">
      {live && verdict !== 'paused' && verdict !== 'unknown' && (
        <span
          className={cn('absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping', dot)}
        />
      )}
      <span className={cn('relative size-2.5 rounded-full', dot)} />
    </span>
  );
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A monitor's card: status, 90 days of uptime, the last day's latency, and when and where it was checked. */
export function MonitorCard({
  monitor,
  live,
  now,
  onOpen,
}: {
  monitor: CloudMonitor;
  live: boolean;
  now: number;
  onOpen: (id: number) => void;
}) {
  const titleId = useId();
  const [hours, setHours] = useState<MonitorHour[] | null>(null);
  const checked = monitor.status.lastCheckedAt;

  // Read again when a new result came in, so the strip and the line follow the status.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new check is the reason to read again
  useEffect(() => {
    let current = true;
    const from = new Date(Date.now() - UPTIME_DAYS * DAY_MS).toISOString();
    void apiRequest<{ items: MonitorHour[] }>(
      `/cloud-monitors/${monitor.id}/hours?from=${encodeURIComponent(from)}`,
    ).then((response) => {
      if (current && response.ok) setHours(response.value.items);
    });
    return () => {
      current = false;
    };
  }, [monitor.id, checked]);

  const bars = dailyBars(hours ?? [], UPTIME_DAYS, now);
  const dayAgo = now - DAY_MS;
  const lastDay = (hours ?? [])
    .filter((one) => Date.parse(one.hour) >= dayAgo)
    .map((one) => one.avgLatencyMs);
  const verdict = monitor.status.verdict;

  return (
    <article
      aria-labelledby={titleId}
      className="app-glass relative flex min-w-0 flex-col gap-3 p-4"
    >
      <div className="flex items-start gap-3">
        <div className="pt-1.5">
          <StatusDot verdict={verdict} live={live} />
        </div>
        <div className="min-w-0 flex-1">
          <h4 id={titleId} className="truncate font-semibold text-[0.95rem] leading-tight">
            <button
              type="button"
              aria-label={`Open ${monitor.name}`}
              onClick={() => onOpen(monitor.id)}
              className="cursor-pointer rounded-sm text-left outline-none after:absolute after:inset-0 after:rounded-box after:content-[''] hover:text-primary focus-visible:after:ring-2 focus-visible:after:ring-ring"
            >
              {monitor.name}
            </button>
          </h4>
          <p className="mt-0.5 truncate font-mono text-[0.72rem] text-muted-foreground">
            {hostOf(monitor.url)}
          </p>
        </div>
        <VerdictPill verdict={verdict} />
      </div>

      {monitor.status.problem && verdict !== 'up' && verdict !== 'paused' ? (
        <p className="line-clamp-2 text-muted-foreground text-xs leading-relaxed">
          {monitor.status.problem}
        </p>
      ) : null}

      {hours === null ? (
        <div
          aria-hidden
          className="h-[2.6rem] animate-pulse rounded-inner bg-foreground/[0.05] motion-reduce:animate-none"
        />
      ) : (
        <UptimeBars bars={bars} label={`Uptime of ${monitor.name}, the last ${UPTIME_DAYS} days`} />
      )}

      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 text-xs">
        <dl className="flex flex-wrap gap-x-4 gap-y-1">
          <div>
            <dt className="text-muted-foreground">Latency</dt>
            <dd className="font-medium tabular-nums">{formatLatency(monitor.status.latencyMs)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">24 h uptime</dt>
            <dd className="font-medium tabular-nums">{formatUptime(monitor.status.uptime24h)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Checked</dt>
            <dd className="font-medium">
              {checked ? relativeTime(checked, now) : monitor.paused ? 'Paused' : 'Not yet'}
              {monitor.status.region ? (
                <span className="text-muted-foreground"> from {monitor.status.region}</span>
              ) : null}
            </dd>
          </div>
        </dl>
        <Sparkline values={lastDay} label={`Latency of ${monitor.name} over the last 24 hours`} />
      </div>
    </article>
  );
}
