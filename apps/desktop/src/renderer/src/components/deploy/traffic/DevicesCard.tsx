import type { TrafficBreakdown } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { compactNumber, formatShare } from '@shared/deploy/trafficFormat';
import { useMemo, useState } from 'react';
import { Monitor } from '@/components/icons';
import { useChartColors } from '@/lib/chartColors';
import { donutSegments } from '@/lib/deploy/traffic/geometry';
import { cn } from '@/lib/utils';
import { DeployCard } from '../deployKit';
import { FILL_BODY, FILL_CARD } from './BreakdownCard';
import { DEVICE_LABELS, TEXT } from './messages';

/** Desktop, mobile and tablet always keep their colour, whatever the order of the counts. */
const KNOWN = ['desktop', 'mobile', 'tablet'];
const R = 50;
const INNER = 36;

/**
 * Devices as a ring: three or four parts of one whole, each with its colour, its name and its
 * share in the legend beside it (so identity never rests on colour alone). Hovering or focusing
 * a part lifts it and names it in the middle.
 */
export function DevicesCard({ breakdown }: { breakdown: TrafficBreakdown }): React.JSX.Element {
  const { categorical } = useChartColors();
  const [active, setActive] = useState<number | null>(null);
  const parts = useMemo(() => {
    // The core names them Desktop, Mobile and Tablet; any case reads the same.
    const byValue = new Map(breakdown.top.map((item) => [item.value.toLowerCase(), item.count]));
    const others = breakdown.top.filter((item) => !KNOWN.includes(item.value.toLowerCase()));
    return [
      ...KNOWN.map((value) => ({ value, count: byValue.get(value) ?? 0 })),
      { value: 'other', count: others.reduce((sum, item) => sum + item.count, 0) },
    ];
  }, [breakdown]);
  const segments = useMemo(
    () =>
      donutSegments(
        parts.map((part) => part.count),
        R,
        INNER,
      ),
    [parts],
  );
  const total = parts.reduce((sum, part) => sum + part.count, 0);
  const shown = active !== null ? parts[active] : null;
  const label = (value: string) => DEVICE_LABELS[value] ?? 'Other';

  return (
    <DeployCard
      icon={<Monitor />}
      title="Devices"
      description="By page views"
      className={FILL_CARD}
      // Beside the taller map, the donut sits in the middle of the spare height.
      bodyClassName={cn(FILL_BODY, 'justify-center')}
    >
      {total === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{TEXT.nothingHere}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-5">
          <svg
            viewBox={`${-R - 4} ${-R - 4} ${2 * R + 8} ${2 * R + 8}`}
            className="h-32 w-32 shrink-0"
            role="img"
            onPointerLeave={() => setActive(null)}
            aria-label={`Devices: ${parts
              .filter((part) => part.count > 0)
              .map((part) => `${label(part.value)} ${formatShare(part.count / total)}`)
              .join(', ')}`}
          >
            {segments.map((segment) => (
              <path
                key={segment.index}
                d={segment.d}
                fill={categorical[segment.index]}
                fillRule="evenodd"
                className="cursor-default outline-none transition-transform motion-reduce:transition-none"
                style={{ transform: active === segment.index ? 'scale(1.04)' : undefined }}
                onPointerMove={() => setActive(segment.index)}
              />
            ))}
            <text
              y={-2}
              textAnchor="middle"
              className="fill-foreground text-[15px] font-semibold"
              aria-hidden
            >
              {shown ? formatShare(shown.count / total) : compactNumber(total)}
            </text>
            <text
              y={13}
              textAnchor="middle"
              className="fill-muted-foreground text-[8px]"
              aria-hidden
            >
              {shown ? label(shown.value) : 'page views'}
            </text>
          </svg>
          <ul className="min-w-[8rem] max-w-xs flex-1 space-y-1.5" aria-label="Devices">
            {parts.map((part, index) =>
              part.count === 0 ? null : (
                <li key={part.value}>
                  <button
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active === index && 'bg-foreground/[0.05]',
                    )}
                    onPointerEnter={() => setActive(index)}
                    onPointerLeave={() => setActive(null)}
                    onFocus={() => setActive(index)}
                    onBlur={() => setActive(null)}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                      style={{ backgroundColor: categorical[index] }}
                    />
                    <span className="flex-1">{label(part.value)}</span>
                    <span className="font-medium tabular-nums">
                      {formatShare(part.count / total)}
                    </span>
                    <span className="w-12 text-right text-[12px] tabular-nums text-muted-foreground">
                      {compactNumber(part.count)}
                    </span>
                  </button>
                </li>
              ),
            )}
          </ul>
        </div>
      )}
    </DeployCard>
  );
}
