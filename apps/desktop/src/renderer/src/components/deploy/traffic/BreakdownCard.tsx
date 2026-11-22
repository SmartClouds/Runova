import type {
  TrafficBreakdown,
  TrafficDimension,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { compactNumber, countryName, formatShare } from '@shared/deploy/trafficFormat';
import { lazy, Suspense, useMemo, useState } from 'react';
import { CountryFlag } from '@/components/CountryFlag';
import { ChevronRight, Globe } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useChartColors } from '@/lib/chartColors';
import { type BreakdownRow, breakdownRows } from '@/lib/deploy/traffic/geometry';
import { catchAllsLast } from '@/lib/deploy/traffic/report';
import { cn } from '@/lib/utils';
import { DeployCard } from '../deployKit';
import { DEVICE_LABELS, DIMENSION_TITLES, DIMENSION_UNITS, TEXT } from './messages';

const DimensionDialog = lazy(() =>
  import('./DimensionDialog').then((module) => ({ default: module.DimensionDialog })),
);

/** How many rows a card shows before "See all". */
const SHOWN = 8;

/**
 * Cards side by side in a report row share the tallest one's height. The card and its body are
 * flex columns, so the body takes the spare room and "See all" stays at the foot.
 */
export const FILL_CARD = 'flex flex-col';
export const FILL_BODY = 'flex flex-1 flex-col';
const MONO: ReadonlySet<TrafficDimension> = new Set([
  'page',
  'entryPage',
  'referrer',
  'statusCode',
]);
const STATUS_WORDS: Record<string, string> = {
  '200': 'OK',
  '204': 'No content',
  '301': 'Moved',
  '302': 'Found',
  '304': 'Not modified',
  '400': 'Bad request',
  '401': 'Unauthorized',
  '403': 'Forbidden',
  '404': 'Not found',
  '429': 'Too many requests',
  '444': 'Blocked',
  '499': 'Closed by client',
  '500': 'Server error',
  '502': 'Bad gateway',
  '503': 'Unavailable',
  '504': 'Gateway timeout',
};

/**
 * A country's flag, or a quiet globe in the same box for Unknown, Tor and Other, so every name in
 * the list starts at the same place.
 */
function Flag({ code }: { code: string }): React.JSX.Element {
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? (
    <CountryFlag countryCode={code} className="h-3 w-[18px] shrink-0 rounded-[2px]" />
  ) : (
    <span className="flex h-3 w-[18px] shrink-0 items-center justify-center rounded-[2px] bg-foreground/[0.07]">
      <Globe className="h-2 w-2 text-muted-foreground" aria-hidden />
    </span>
  );
}

/** A breakdown value as people read it: a country's flag and name, a device's word, a status code's meaning. */
export function ValueLabel({
  dimension,
  value,
}: {
  dimension: TrafficDimension;
  value: string;
}): React.JSX.Element {
  if (dimension === 'country') {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <Flag code={value} />
        <span className="truncate">{countryName(value)}</span>
      </span>
    );
  }
  if (dimension === 'city') {
    // The core counts cities as "City, CC".
    const match = /^(.*), ([A-Z]{2})$/.exec(value);
    return (
      <span className="flex min-w-0 items-center gap-2">
        <Flag code={match ? match[2] : ''} />
        <span className="truncate">{match ? match[1] : value}</span>
        {match && <span className="shrink-0 text-muted-foreground">{countryName(match[2])}</span>}
      </span>
    );
  }
  if (dimension === 'device') return <span>{DEVICE_LABELS[value.toLowerCase()] ?? value}</span>;
  if (dimension === 'statusCode') {
    return (
      <span className="truncate">
        <span className="font-mono">{value}</span>
        {STATUS_WORDS[value] && (
          <span className="text-muted-foreground"> {STATUS_WORDS[value]}</span>
        )}
      </span>
    );
  }
  return (
    <span className={cn('truncate', MONO.has(dimension) && 'font-mono text-[12px]')}>
      {value === '' ? '(none)' : value}
    </span>
  );
}

/**
 * Rows of one breakdown: the value over a quiet wash as long as its count against the largest,
 * the count, and its share of the whole. The wash is one colour for every row, since rows are one
 * series; the numbers carry the rest.
 */
export function BreakdownRows({
  dimension,
  rows,
  label,
}: {
  dimension: TrafficDimension;
  rows: BreakdownRow[];
  label: string;
}): React.JSX.Element {
  const { green } = useChartColors();
  return (
    <ol aria-label={label} className="space-y-0.5">
      {rows.map((row) => (
        <li
          key={row.value}
          className="relative flex h-7 items-center gap-3 rounded-md px-2 text-[13px]"
          title={`${row.value}: ${compactNumber(row.count)} (${formatShare(row.share)})`}
        >
          <span
            aria-hidden
            data-bar
            className="absolute inset-y-0 left-0 rounded-md"
            style={{ width: `${row.bar}%`, backgroundColor: green, opacity: 0.14 }}
          />
          <span className="relative min-w-0 flex-1">
            <ValueLabel dimension={dimension} value={row.value} />
          </span>
          <span className="relative shrink-0 text-right text-[12px] tabular-nums">
            <span className="font-medium">{compactNumber(row.count)}</span>
            <span className="inline-block w-12 text-muted-foreground">
              {formatShare(row.share)}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function BreakdownCard({
  serverId,
  siteId,
  range,
  breakdown,
  icon,
  className,
}: {
  serverId: string;
  siteId: string | null;
  range: { fromUnixMs: number; toUnixMs: number };
  breakdown: TrafficBreakdown;
  icon: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { dimension } = breakdown;
  const title = DIMENSION_TITLES[dimension];
  const rows = useMemo(
    // The top values by count, with any catch-all among them moved to the foot.
    () => breakdownRows(catchAllsLast(breakdown.top.slice(0, SHOWN), dimension), breakdown.total),
    [breakdown, dimension],
  );
  return (
    <DeployCard
      icon={icon}
      title={title}
      description={`By ${DIMENSION_UNITS[dimension]}`}
      className={cn(FILL_CARD, className)}
      bodyClassName={FILL_BODY}
    >
      {rows.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{TEXT.nothingHere}</p>
      ) : (
        <>
          <BreakdownRows dimension={dimension} rows={rows} label={title} />
          {/* At the foot of the list, so a narrow card keeps its title on one line. */}
          <div className="-mb-1.5 mt-auto flex justify-end pt-1.5">
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              {TEXT.seeAll} <ChevronRight />
            </Button>
          </div>
        </>
      )}
      {open && (
        <Suspense fallback={null}>
          <DimensionDialog
            serverId={serverId}
            siteId={siteId}
            range={range}
            dimension={dimension}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </DeployCard>
  );
}
