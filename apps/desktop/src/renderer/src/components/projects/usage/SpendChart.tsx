import type { ProjectUsageDay } from '@shared/apiTypes';
import { useMemo } from 'react';
import { PillTabs, SECTION_HEADING } from '@/components/pageKit';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useProjectUiState } from '@/hooks/useProjectUiState';
import {
  barRangeLabel,
  barValue,
  buildChart,
  type ChartBar,
  type ChartMetric,
  formatDayLabel,
  hasCost,
  peakIndex,
} from '@/lib/usageBuckets';
import { formatTokens } from '@/lib/usageFormat';
import { cn } from '@/lib/utils';
import { formatMoney } from './formatMoney';

/** A bar with spend is never thinner than this, so a small day is still a visible mark. */
const MIN_BAR_PERCENT = 4;

const METRICS = [
  { value: 'cost', label: 'Cost' },
  { value: 'tokens', label: 'Tokens' },
] as const;

function valueText(value: number, metric: ChartMetric): string {
  return metric === 'cost' ? (formatMoney(value) ?? '$0.00') : formatTokens(value);
}

/** What a bar says to a screen reader, and to anyone hovering it. */
function barName(bar: ChartBar, withYear: boolean): string {
  const range = barRangeLabel(bar, withYear);
  if (bar.tokens === 0) return `${range}: no usage`;
  const cost = formatMoney(bar.costUsd);
  return cost
    ? `${range}: ${cost}, ${formatTokens(bar.tokens)} tokens`
    : `${range}: ${formatTokens(bar.tokens)} tokens (unpriced)`;
}

function BarTip({ bar, withYear }: { bar: ChartBar; withYear: boolean }): React.JSX.Element {
  const cost = formatMoney(bar.costUsd);
  return (
    <div className="space-y-0.5 tabular-nums">
      <div className="font-medium">{barRangeLabel(bar, withYear)}</div>
      {bar.tokens === 0 ? (
        <div className="text-muted-foreground">No usage</div>
      ) : (
        <div>
          {cost ?? 'Unpriced'}
          <span className="text-muted-foreground"> · {formatTokens(bar.tokens)} tokens</span>
        </div>
      )}
    </div>
  );
}

/**
 * Spend over time, a bar per day (or per week for a long period). Cost is the headline; when no
 * day has a known cost the chart can only show tokens, and says so by not offering the choice.
 */
export function SpendChart({
  byDay,
  days,
}: {
  byDay: ProjectUsageDay[];
  days: number | null;
}): React.JSX.Element {
  const costKnown = hasCost(byDay);
  const [chosen, setChosen] = useProjectUiState<ChartMetric>('usage.metric', 'cost');
  const metric: ChartMetric = costKnown ? chosen : 'tokens';
  const chart = useMemo(() => buildChart(byDay, days, new Date()), [byDay, days]);
  const { bars, grain } = chart;

  const max = Math.max(0, ...bars.map((bar) => barValue(bar, metric)));
  const peak = peakIndex(bars, metric);
  const withYear =
    bars.length > 0 && bars[0].from.slice(0, 4) !== bars[bars.length - 1].to.slice(0, 4);
  const unit = grain === 'day' ? 'day' : 'week';
  const what = metric === 'cost' ? 'Spend' : 'Tokens';

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <h3 className={SECTION_HEADING}>{what} over time</h3>
          {peak !== null ? (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {`Peak ${valueText(barValue(bars[peak], metric), metric)} ${
                grain === 'day' ? 'on' : 'the week of'
              } ${formatDayLabel(bars[peak].from, withYear)}`}
            </span>
          ) : null}
        </div>
        {costKnown ? (
          <PillTabs
            id="project-usage-metric"
            label="Chart metric"
            kind="toggle"
            size="xs"
            items={[...METRICS]}
            value={metric}
            onChange={setChosen}
          />
        ) : null}
      </div>

      <div className="relative">
        {/* Hairlines behind the bars give the heights something to read against. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex flex-col justify-between"
        >
          {[0, 1, 2, 3].map((line) => (
            <div key={line} className="h-px w-full bg-foreground/[0.05]" />
          ))}
        </div>
        <ul aria-label={`${what} per ${unit}`} className="relative flex h-32 items-end gap-[3px]">
          {bars.map((bar, i) => {
            const value = barValue(bar, metric);
            const percent =
              max > 0 && value > 0 ? Math.max(MIN_BAR_PERCENT, (value / max) * 100) : 0;
            return (
              <SimpleTooltip
                key={bar.from}
                label={<BarTip bar={bar} withYear={withYear} />}
                side="top"
                delayDuration={100}
              >
                <li
                  aria-label={barName(bar, withYear)}
                  className="group flex h-full min-w-0 flex-1 items-end rounded-t-[4px] transition-colors hover:bg-foreground/[0.04]"
                >
                  <span
                    className={cn(
                      'block w-full rounded-t-[3px] transition-colors',
                      percent === 0
                        ? 'h-[2px] bg-foreground/[0.08]'
                        : i === peak
                          ? 'bg-primary'
                          : 'bg-primary/55 group-hover:bg-primary/85',
                    )}
                    style={percent > 0 ? { height: `${percent}%` } : undefined}
                  />
                </li>
              </SimpleTooltip>
            );
          })}
        </ul>
      </div>

      {bars.length > 0 ? (
        <div className="mt-1.5 flex justify-between text-[10px] tabular-nums text-muted-foreground">
          <span>{formatDayLabel(bars[0].from, withYear)}</span>
          <span>{formatDayLabel(bars[bars.length - 1].to, withYear)}</span>
        </div>
      ) : null}
    </div>
  );
}
