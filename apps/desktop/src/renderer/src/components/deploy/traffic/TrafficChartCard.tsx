import type {
  TrafficPoint,
  TrafficReport,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { compactNumber } from '@shared/deploy/trafficFormat';
import { axisLabel, bucketLabel } from '@shared/deploy/trafficRanges';
import { useMemo, useState } from 'react';
import { ChartColumn, ChartSimple, Table } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useChartColors } from '@/lib/chartColors';
import { comparison, previousLine } from '@/lib/deploy/traffic/report';
import { DeployCard } from '../deployKit';
import { TABLE_CELL, TABLE_HEAD } from '../security/SecurityCard';
import { TEXT } from './messages';
import { ChartLegend, TimeChart, type TimeSeries } from './TimeChart';

/** The table view keeps to the newest rows, so a year by the day stays a page long. */
const TABLE_ROWS = 90;

/**
 * The report's main chart: visitors and page views over the range, the period before dashed
 * behind them, with a table of the same numbers a click away.
 */
export function TrafficChartCard({ report }: { report: TrafficReport }): React.JSX.Element {
  const [table, setTable] = useState(false);
  const { green, blue } = useChartColors();
  const { granularity, timeZone } = report;

  const series = useMemo((): TimeSeries[] => {
    const previous = report.previousSeries;
    const { firstPrevious } = comparison(report);
    const before = (pick: (point: TrafficPoint) => number) =>
      previous ? previousLine(previous.map(pick), firstPrevious) : null;
    const visitorsBefore = before((point) => point.visitors);
    const pageViewsBefore = before((point) => point.pageViews);
    return [
      {
        key: 'visitors',
        label: 'Visitors',
        color: green,
        values: report.series.map((point) => point.visitors),
        ...(visitorsBefore ? { previous: visitorsBefore } : {}),
      },
      {
        key: 'pageViews',
        label: 'Page views',
        color: blue,
        values: report.series.map((point) => point.pageViews),
        ...(pageViewsBefore ? { previous: pageViewsBefore } : {}),
      },
    ];
  }, [report, green, blue]);
  const times = useMemo(() => report.series.map((point) => point.startUnixMs), [report]);
  const before = series[1]?.previous;
  const compared = before !== undefined;

  return (
    <DeployCard
      icon={<ChartColumn />}
      title={TEXT.chartTitle}
      description={
        <ChartLegend series={series} previousLabel={compared ? TEXT.previous : undefined} />
      }
      actions={
        <Button
          size="sm"
          variant="soft"
          aria-pressed={table}
          onClick={() => setTable((current) => !current)}
        >
          {table ? <ChartSimple /> : <Table />}
          {table ? 'Chart' : 'Table'}
        </Button>
      }
    >
      {table ? (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-xs tabular-nums" aria-label="Visitors and page views">
            <thead className="sticky top-0 bg-card text-left">
              <tr>
                <th className={TABLE_HEAD}>When</th>
                <th className={TABLE_HEAD}>Visitors</th>
                <th className={TABLE_HEAD}>Visits</th>
                <th className={TABLE_HEAD}>Page views</th>
                {compared && <th className={TABLE_HEAD}>Page views before</th>}
              </tr>
            </thead>
            <tbody>
              {report.series
                .map((point, index) => ({ point, index }))
                .slice(-TABLE_ROWS)
                .reverse()
                .map(({ point, index }) => (
                  <tr
                    key={point.startUnixMs}
                    className="[&>td]:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]"
                  >
                    <td className={TABLE_CELL}>
                      {bucketLabel(point.startUnixMs, granularity, timeZone)}
                    </td>
                    <td className={TABLE_CELL}>{compactNumber(point.visitors)}</td>
                    <td className={TABLE_CELL}>{compactNumber(point.visits)}</td>
                    <td className={TABLE_CELL}>{compactNumber(point.pageViews)}</td>
                    {compared && (
                      <td className={TABLE_CELL}>
                        {before?.[index] == null ? '' : compactNumber(before[index] ?? 0)}
                      </td>
                    )}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <TimeChart
          title={TEXT.chartTitle}
          times={times}
          series={series}
          formatValue={compactNumber}
          formatTick={compactNumber}
          bucketLabel={(at) => bucketLabel(at, granularity, timeZone)}
          axisLabel={(at) => axisLabel(at, granularity, timeZone)}
          previousLabel={TEXT.previous}
        />
      )}
    </DeployCard>
  );
}
