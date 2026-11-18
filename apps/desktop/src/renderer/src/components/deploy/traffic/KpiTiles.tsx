import type { TrafficReport } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { changeText } from '@shared/deploy/trafficFormat';
import { useMemo } from 'react';
import { ArrowDown, ArrowUp, CircleInfo, Minus } from '@/components/icons';
import { GLASS_CARD } from '@/components/pageKit';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useChartColors } from '@/lib/chartColors';
import { linePath, niceMax } from '@/lib/deploy/traffic/geometry';
import { changeTone, type KpiFigure, kpiFigures } from '@/lib/deploy/traffic/report';
import { cn } from '@/lib/utils';
import { KPI_TEXT, TEXT } from './messages';

const TONE = {
  good: 'text-success',
  bad: 'text-destructive',
  neutral: 'text-muted-foreground',
} as const;

const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 26;

/** The trend under a tile: the series in the quiet hue, the latest bucket marked in the accent. */
function Sparkline({ values, accent }: { values: number[]; accent: string }): React.JSX.Element {
  const max = niceMax(Math.max(0, ...values));
  const last = values.length - 1;
  const y = SPARK_HEIGHT * (1 - Math.min(1, (values[last] ?? 0) / max));
  return (
    <svg
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      className="h-6 w-full min-w-10 max-w-24 overflow-visible"
      aria-hidden
    >
      <path
        d={linePath(values, SPARK_WIDTH, SPARK_HEIGHT, max)}
        fill="none"
        stroke="hsl(var(--muted-foreground) / 0.55)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {last >= 0 && <circle cx={SPARK_WIDTH} cy={y} r={2.5} fill={accent} />}
    </svg>
  );
}

function Tile({ figure, accent }: { figure: KpiFigure; accent: string }): React.JSX.Element {
  const text = KPI_TEXT[figure.key];
  const tone = changeTone(figure.change, figure.goodWhenUp);
  const Arrow =
    figure.change?.direction === 'up'
      ? ArrowUp
      : figure.change?.direction === 'down'
        ? ArrowDown
        : Minus;
  return (
    <div
      className={cn(GLASS_CARD, 'flex min-w-0 flex-col gap-1.5 p-3.5')}
      data-kpi={figure.key}
      role="group"
      aria-label={text.label}
    >
      <SimpleTooltip label={text.hint}>
        <span
          tabIndex={0}
          className="flex w-fit cursor-help items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {text.label}
          <CircleInfo className="h-3 w-3 opacity-50" aria-hidden />
        </span>
      </SimpleTooltip>
      <div className="flex min-h-8 items-end justify-between gap-3">
        <div className="flex shrink-0 items-baseline gap-1 whitespace-nowrap text-2xl font-semibold leading-none tracking-tight">
          {figure.key === 'visitors' && (
            <span className="text-xs font-normal text-muted-foreground">about</span>
          )}
          <span>{figure.value}</span>
        </div>
        {figure.spark && figure.spark.length > 1 && (
          // The trend gives way to the number when the tile is narrow.
          <span className="flex min-w-0 flex-1 justify-end">
            <Sparkline values={figure.spark} accent={accent} />
          </span>
        )}
      </div>
      <div
        className={cn(
          'flex h-4 items-center gap-1 whitespace-nowrap text-[11px] font-medium',
          TONE[tone],
        )}
      >
        {figure.change ? (
          <>
            <Arrow className="h-2.5 w-2.5 shrink-0" aria-hidden />
            <span>{changeText(figure.change)}</span>
            <span className="truncate font-normal text-muted-foreground">vs the period before</span>
          </>
        ) : figure.noEarlierData ? (
          <span className="font-normal text-muted-foreground">{TEXT.noEarlierData}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The report's headline figures as eight tiles: the value, how it moved against the period before
 * (arrow, words and colour, never colour alone; green is good news, which for the bounce rate and
 * the bot share is a fall), and the trend where the series holds one.
 */
export function KpiTiles({ report }: { report: TrafficReport }): React.JSX.Element {
  const { green } = useChartColors();
  const figures = useMemo(() => kpiFigures(report), [report]);
  return (
    <div className="grid grid-cols-2 gap-2 @3xl/traffic:grid-cols-4">
      {figures.map((figure) => (
        <Tile key={figure.key} figure={figure} accent={green} />
      ))}
    </div>
  );
}
