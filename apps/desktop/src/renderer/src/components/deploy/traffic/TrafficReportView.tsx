import { coreErrorMessage } from '@shared/coreErrors';
import type {
  TrafficGranularity,
  TrafficStatus,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import {
  type CustomDays,
  customRangeProblem,
  DAY_MS,
  dateInZone,
  defaultGranularity,
  fitGranularity,
  granularityChoices,
  RANGE_OPTIONS,
  rangeWindow,
  type TrafficRange,
} from '@shared/deploy/trafficRanges';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChartColumn,
  FileText,
  Layers,
  Link,
  Monitor,
  Robot,
  Route,
  ShieldSolid,
} from '@/components/icons';
import {
  Chip,
  EmptyState,
  LoadFailure,
  Notice,
  SEGMENT_TRACK,
  segmentClass,
} from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { breakdownOf } from '@/lib/deploy/traffic/report';
import { cn } from '@/lib/utils';
import { BreakdownCard } from './BreakdownCard';
import { CountriesCard } from './CountriesCard';
import { DevicesCard } from './DevicesCard';
import { HourHeatmap } from './HourHeatmap';
import { useTrafficLive, useTrafficReport } from './hooks';
import { KpiTiles } from './KpiTiles';
import { TEXT } from './messages';
import { ResponseCard } from './ResponseCard';
import { SecurityCard } from './SecurityCard';
import { TrafficChartCard } from './TrafficChartCard';

function lastWeek(now: number, timeZone: string): CustomDays {
  return { from: dateInZone(now - 6 * DAY_MS, timeZone), to: dateInZone(now, timeZone) };
}

function ReportSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-2" aria-busy="true">
      <div className="grid grid-cols-2 gap-2 @3xl/traffic:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-[92px] rounded-[calc(var(--radius)+2px)]" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-[calc(var(--radius)+2px)]" />
      <div className="grid gap-2 @3xl/traffic:grid-cols-2">
        <Skeleton className="h-64 rounded-[calc(var(--radius)+2px)]" />
        <Skeleton className="h-64 rounded-[calc(var(--radius)+2px)]" />
      </div>
    </div>
  );
}

function LiveChip({ serverId, siteId }: { serverId: string; siteId: string | null }) {
  const live = useTrafficLive(serverId, siteId, true);
  if (!live) {
    return (
      <Chip tone="neutral" dot>
        {TEXT.liveWaiting}
      </Chip>
    );
  }
  return (
    <SimpleTooltip label={TEXT.liveTitle(live.requestsLastMinute)}>
      <Chip tone="success" dot pulse={live.visitorsNow > 0} tabIndex={0} aria-live="polite">
        {TEXT.liveNow(live.visitorsNow)}
      </Chip>
    </SimpleTooltip>
  );
}

/**
 * One traffic report (E109): the filters in one row above everything they scope (range, buckets,
 * the comparison, live visitors), then the figures, the main chart, the breakdowns, the map, the
 * hours of the week, responses and attacks. A new range keeps the report on screen, dimmed, until
 * the new one is in; nothing jumps.
 */
export function TrafficReportView({
  serverId,
  status,
  siteId,
  admin,
  siteNames,
  leading,
  trailing,
  focusSecurity = false,
  onUpdateCore,
  onOpenDetection,
}: {
  serverId: string;
  status: TrafficStatus;
  siteId: string | null;
  admin: boolean;
  siteNames: ReadonlyMap<string, string>;
  /** Sits first in the filter row: the site picker. */
  leading?: React.ReactNode;
  /** Sits last in the filter row: the settings button. */
  trailing?: React.ReactNode;
  /** Scrolls to the attacks, for an attack alert that opened the section. */
  focusSecurity?: boolean;
  onUpdateCore?: (() => void) | undefined;
  onOpenDetection?: () => void;
}): React.JSX.Element {
  const timeZone = status.settings.timeZone || status.defaultTimeZone;
  const [range, setRange] = useState<TrafficRange>('7d');
  const [custom, setCustom] = useState<CustomDays>(() => lastWeek(Date.now(), timeZone));
  const [draft, setDraft] = useState<CustomDays>(custom);
  const [picked, setPicked] = useState<TrafficGranularity | null>(null);
  const [compare, setCompare] = useState(true);
  const securityRef = useRef<HTMLDivElement>(null);

  const window_ = useMemo(
    () => rangeWindow(range, Date.now(), timeZone, range === 'custom' ? custom : undefined),
    [range, custom, timeZone],
  );
  const preferred = defaultGranularity(range, window_.to - window_.from);
  const choices = useMemo(
    () => granularityChoices(window_, Date.now(), status.settings.hourlyRetentionDays),
    [window_, status.settings.hourlyRetentionDays],
  );
  const granularity = fitGranularity(picked ?? preferred, choices, preferred);
  const report = useTrafficReport(serverId, {
    siteId,
    range,
    ...(range === 'custom' ? { custom } : {}),
    granularity,
    compare,
    timeZone,
  });
  const draftProblem = customRangeProblem(draft.from, draft.to, Date.now(), timeZone);

  useEffect(() => {
    if (focusSecurity && report.data) {
      securityRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    }
  }, [focusSecurity, report.data]);

  const data = report.data;
  const empty = data !== undefined && data.totals.requests === 0;
  const range_ = data ? { fromUnixMs: data.fromUnixMs, toUnixMs: data.toUnixMs } : null;

  return (
    <div className="@container/traffic space-y-2">
      <div
        role="toolbar"
        aria-label="Report filters"
        className="glass space-y-2 rounded-[calc(var(--radius)+2px)] p-2"
      >
        <div className="flex flex-wrap items-center gap-2">
          {leading}
          <div role="radiogroup" aria-label="Range" className={SEGMENT_TRACK}>
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={option.value === range}
                className={segmentClass(option.value === range)}
                onClick={() => {
                  setRange(option.value);
                  setPicked(null);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Buckets" className={SEGMENT_TRACK}>
            {choices.map((choice) => (
              <SimpleTooltip key={choice.value} label={choice.reason} wrapTrigger={!choice.enabled}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={choice.value === granularity}
                  disabled={!choice.enabled}
                  className={cn(
                    segmentClass(choice.value === granularity),
                    'disabled:cursor-not-allowed disabled:opacity-40',
                  )}
                  onClick={() => setPicked(choice.value)}
                >
                  {choice.label}
                </button>
              </SimpleTooltip>
            ))}
          </div>
          <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <Switch checked={compare} onCheckedChange={setCompare} aria-label={TEXT.compare} />
            Compare
          </label>
          <span className="ml-auto flex items-center gap-2">
            <LiveChip serverId={serverId} siteId={siteId} />
            {trailing}
          </span>
        </div>
        {range === 'custom' && (
          <form
            className="flex w-full flex-wrap items-center gap-2 px-1 text-xs"
            onSubmit={(event) => {
              event.preventDefault();
              if (!draftProblem) setCustom(draft);
            }}
          >
            <label className="flex items-center gap-1.5">
              From
              <Input
                type="date"
                aria-label="First day"
                value={draft.from}
                onChange={(event) => setDraft((d) => ({ ...d, from: event.target.value }))}
                className="h-7 w-36"
              />
            </label>
            <label className="flex items-center gap-1.5">
              to
              <Input
                type="date"
                aria-label="Last day"
                value={draft.to}
                onChange={(event) => setDraft((d) => ({ ...d, to: event.target.value }))}
                className="h-7 w-36"
              />
            </label>
            <Button type="submit" size="sm" variant="soft" disabled={draftProblem !== null}>
              Show
            </Button>
            {draftProblem && <span className="text-destructive">{draftProblem}</span>}
          </form>
        )}
      </div>

      {report.isPending ? (
        <ReportSkeleton />
      ) : report.isError && !data ? (
        TEXT.olderCore.test(coreErrorMessage(report.error)) ? (
          <Notice
            tone="warning"
            action={
              onUpdateCore ? (
                <Button size="sm" onClick={onUpdateCore}>
                  {TEXT.updateCore}
                </Button>
              ) : undefined
            }
          >
            {coreErrorMessage(report.error)}
          </Notice>
        ) : (
          <LoadFailure
            message={coreErrorMessage(report.error)}
            retry={() => void report.refetch()}
          />
        )
      ) : data && range_ ? (
        <div
          className={cn(
            'space-y-2 transition-opacity motion-reduce:transition-none',
            report.isPlaceholderData && 'opacity-60',
          )}
          aria-busy={report.isPlaceholderData}
        >
          {empty ? (
            <EmptyState
              card
              icon={ChartColumn}
              title={TEXT.emptyTitle}
              description={TEXT.emptyBody}
            />
          ) : (
            <>
              <KpiTiles report={data} />
              <TrafficChartCard report={data} />
              <div className="grid gap-2 @3xl/traffic:grid-cols-2">
                <BreakdownCard
                  serverId={serverId}
                  siteId={siteId}
                  range={range_}
                  breakdown={breakdownOf(data, 'page')}
                  icon={<FileText />}
                />
                <BreakdownCard
                  serverId={serverId}
                  siteId={siteId}
                  range={range_}
                  breakdown={breakdownOf(data, 'entryPage')}
                  icon={<Route />}
                />
              </div>
              <div className="grid gap-2 @5xl/traffic:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <CountriesCard
                  serverId={serverId}
                  report={data}
                  countriesOn={status.settings.countries}
                />
                <DevicesCard breakdown={breakdownOf(data, 'device')} />
              </div>
              <div className="grid gap-2 @3xl/traffic:grid-cols-3">
                <BreakdownCard
                  serverId={serverId}
                  siteId={siteId}
                  range={range_}
                  breakdown={breakdownOf(data, 'referrer')}
                  icon={<Link />}
                />
                <BreakdownCard
                  serverId={serverId}
                  siteId={siteId}
                  range={range_}
                  breakdown={breakdownOf(data, 'browser')}
                  icon={<Monitor />}
                />
                <BreakdownCard
                  serverId={serverId}
                  siteId={siteId}
                  range={range_}
                  breakdown={breakdownOf(data, 'operatingSystem')}
                  icon={<Layers />}
                />
              </div>
              <div className="grid gap-2 @3xl/traffic:grid-cols-2">
                <HourHeatmap values={data.hourOfWeek} timeZone={data.timeZone} />
                <ResponseCard report={data} />
              </div>
            </>
          )}
          <SecurityCard
            ref={securityRef}
            serverId={serverId}
            siteId={siteId}
            admin={admin}
            detectionOn={status.attacks.enabled}
            timeZone={timeZone}
            siteNames={siteNames}
            {...(onOpenDetection ? { onOpenSettings: onOpenDetection } : {})}
          />
          {!empty && (
            <div className="grid gap-2 @3xl/traffic:grid-cols-2">
              <BreakdownCard
                serverId={serverId}
                siteId={siteId}
                range={range_}
                breakdown={breakdownOf(data, 'statusCode')}
                icon={<ShieldSolid />}
              />
              <BreakdownCard
                serverId={serverId}
                siteId={siteId}
                range={range_}
                breakdown={breakdownOf(data, 'bot')}
                icon={<Robot />}
              />
            </div>
          )}
          <p className="px-1 text-[11px] text-muted-foreground">{TEXT.estimates}</p>
        </div>
      ) : null}
    </div>
  );
}
