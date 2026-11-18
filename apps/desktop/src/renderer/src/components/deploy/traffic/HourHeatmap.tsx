import { compactNumber } from '@shared/deploy/trafficFormat';
import { useMemo, useState } from 'react';
import { CalendarDays } from '@/components/icons';
import { useChartColors } from '@/lib/chartColors';
import { hourOfWeekRows } from '@/lib/deploy/traffic/geometry';
import { cn } from '@/lib/utils';
import { DeployCard } from '../deployKit';
import { shade } from './shades';

const STEPS = 5;
const FULL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function hour(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}

/**
 * When people come, as a week of hours (Monday first, in the report's time zone): each cell shaded
 * by page views on one green ramp. A cell names its hour and count on hover, and the arrow keys
 * walk the grid with the same readout, so the numbers are reachable without a pointer.
 */
export function HourHeatmap({
  values,
  timeZone,
}: {
  values: readonly number[];
  timeZone: string;
}): React.JSX.Element {
  const { green } = useChartColors();
  const rows = useMemo(() => hourOfWeekRows(values), [values]);
  const max = useMemo(() => Math.max(0, ...values), [values]);
  const [cursor, setCursor] = useState<{ day: number; hour: number } | null>(null);
  const step = (value: number) => (value > 0 && max > 0 ? Math.ceil((STEPS * value) / max) : 0);
  const busiest = useMemo(() => {
    let best = { day: 0, hour: 0, value: -1 };
    rows.forEach((row, day) =>
      row.hours.forEach((value, h) => {
        if (value > best.value) best = { day, hour: h, value };
      }),
    );
    return best;
  }, [rows]);

  function onKeyDown(event: React.KeyboardEvent): void {
    const at = cursor ?? { day: busiest.day, hour: busiest.hour };
    const moves: Record<string, { day: number; hour: number }> = {
      ArrowLeft: { day: at.day, hour: Math.max(0, at.hour - 1) },
      ArrowRight: { day: at.day, hour: Math.min(23, at.hour + 1) },
      ArrowUp: { day: Math.max(0, at.day - 1), hour: at.hour },
      ArrowDown: { day: Math.min(6, at.day + 1), hour: at.hour },
    };
    if (event.key === 'Escape') {
      setCursor(null);
      return;
    }
    const next = moves[event.key];
    if (!next) return;
    event.preventDefault();
    setCursor(next);
  }

  const readout = cursor
    ? `${FULL_DAYS[cursor.day]} ${hour(cursor.hour)} to ${hour((cursor.hour + 1) % 24)}: ${compactNumber(rows[cursor.day].hours[cursor.hour])} page views`
    : max > 0
      ? `Busiest: ${FULL_DAYS[busiest.day]} around ${hour(busiest.hour)}`
      : 'No page views in this range.';

  return (
    <DeployCard
      icon={<CalendarDays />}
      title="Busiest hours"
      description={`Page views by hour of the week, ${timeZone} time`}
    >
      <div
        role="grid"
        aria-label={`Page views by hour of the week. ${readout}. Use the arrow keys to read each hour.`}
        tabIndex={0}
        className="grid gap-[2px] rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ gridTemplateColumns: 'auto repeat(24, minmax(0, 1fr))' }}
        onKeyDown={onKeyDown}
        onBlur={() => setCursor(null)}
        onPointerLeave={() => setCursor(null)}
      >
        {rows.map((row, day) => (
          <div key={row.day} role="row" className="contents">
            <span role="rowheader" className="pr-1.5 text-[10px] leading-4 text-muted-foreground">
              {row.day}
            </span>
            {row.hours.map((value, h) => (
              <span
                key={h}
                role="gridcell"
                aria-label={`${row.day} ${hour(h)}: ${value}`}
                data-step={step(value)}
                className={cn(
                  'h-4 rounded-[3px]',
                  cursor?.day === day && cursor.hour === h && 'ring-2 ring-foreground ring-inset',
                )}
                style={{ background: shade(step(value), green) }}
                onPointerEnter={() => setCursor({ day, hour: h })}
              />
            ))}
          </div>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} aria-hidden className="text-[9px] leading-3 text-muted-foreground">
            {h % 6 === 0 ? hour(h).slice(0, 2) : ''}
          </span>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
        {readout}
      </p>
    </DeployCard>
  );
}
