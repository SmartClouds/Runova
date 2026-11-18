import type { TrafficReport } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { compactNumber, formatMs, formatShare } from '@shared/deploy/trafficFormat';
import { axisLabel, bucketLabel } from '@shared/deploy/trafficRanges';
import { useMemo } from 'react';
import { Gauge } from '@/components/icons';
import { statusColumns } from '@/lib/deploy/traffic/report';
import { DeployCard } from '../deployKit';
import { StackedColumns } from './StackedColumns';

/**
 * How the sites answered: the average and slowest-5% response times, and every request's status
 * over time, stacked. These colours mean something (fine, a client's mistake, the server's fault),
 * so they are the app's status colours, each named in the legend with its count.
 */
export function ResponseCard({ report }: { report: TrafficReport }): React.JSX.Element {
  const { totals, granularity, timeZone } = report;
  const columns = useMemo(() => statusColumns(report.series), [report.series]);
  const times = useMemo(() => report.series.map((point) => point.startUnixMs), [report.series]);
  const errors = totals.status4xx + totals.status5xx;
  const series = [
    { key: 'ok', label: 'Answered (2xx, 3xx)', color: 'hsl(var(--success) / 0.4)' },
    { key: 'client', label: 'Client errors (4xx)', color: 'hsl(var(--warning))' },
    { key: 'server', label: 'Server errors (5xx)', color: 'hsl(var(--destructive))' },
  ];
  return (
    <DeployCard
      icon={<Gauge />}
      title="Responses"
      description="How fast and how well the sites answered"
    >
      <dl className="mb-4 grid grid-cols-3 gap-3">
        <div>
          <dt className="text-xs text-muted-foreground">Average</dt>
          <dd className="text-xl font-semibold tracking-tight">
            {formatMs(totals.averageResponseMs)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Slowest 5% over</dt>
          <dd className="text-xl font-semibold tracking-tight">{formatMs(totals.p95ResponseMs)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Errors</dt>
          <dd className="text-xl font-semibold tracking-tight">
            {formatShare(totals.requests > 0 ? errors / totals.requests : 0)}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              {compactNumber(errors)}
            </span>
          </dd>
        </div>
      </dl>
      <StackedColumns
        title="Requests by status"
        times={times}
        columns={columns}
        series={series}
        formatValue={compactNumber}
        bucketLabel={(at) => bucketLabel(at, granularity, timeZone)}
        axisLabel={(at) => axisLabel(at, granularity, timeZone)}
      />
    </DeployCard>
  );
}
