import { coreErrorMessage } from '@shared/coreErrors';
import type {
  AttackEventInfo,
  AttackKind,
  BlockedAddressInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { compactNumber, countryName } from '@shared/deploy/trafficFormat';
import { axisLabel, bucketLabel } from '@shared/deploy/trafficRanges';
import { ATTACK_KINDS, attackKindLabel } from '@shared/deploy/trafficValidation';
import { useQueryClient } from '@tanstack/react-query';
import { forwardRef, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CountryFlag } from '@/components/CountryFlag';
import { Ban, Shield, Sliders, Spinner } from '@/components/icons';
import { Chip, Notice, SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useChartColors } from '@/lib/chartColors';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { ago, fromNow } from '../security/format';
import { CARD_BODY, SecurityCard as Card, TABLE_CELL, TABLE_HEAD } from '../security/SecurityCard';
import { useAttacks, useBlocked } from './hooks';
import { SECURITY_TEXT } from './messages';
import { StackedColumns } from './StackedColumns';

const HOUR = 3_600_000;
/** Each kind keeps its slot in the chart's categorical order, whatever is shown. */
const KIND_SLOT: Record<AttackKind, number> = { scan: 2, bruteForce: 5, flood: 6, injection: 3 };
const SHOWN_EVENTS = 12;

function Paths({ paths }: { paths: string[] }): React.JSX.Element {
  const [first, second, ...rest] = paths;
  return (
    <span
      className="block max-w-[18rem] truncate font-mono text-[11px] text-muted-foreground"
      title={paths.join('\n')}
    >
      {[first, second].filter(Boolean).join('  ')}
      {rest.length > 0 && ` +${rest.length}`}
    </span>
  );
}

/**
 * Attacks on the server's websites (E110 T7): scans, password guessing, floods and injection probes
 * over the last 7 days, the addresses behind the recent ones with what they tried, and the blocked
 * addresses. An Admin blocks an address after reading what that does, and lets it back the same
 * way. The colours of the kinds are identity only; every kind is also named.
 */
export const SecurityCard = forwardRef<
  HTMLDivElement,
  {
    serverId: string;
    siteId: string | null;
    admin: boolean;
    detectionOn: boolean;
    timeZone: string;
    /** Site ids to the first domain, for naming them. */
    siteNames: ReadonlyMap<string, string>;
    onOpenSettings?: () => void;
  }
>(function SecurityCard(
  { serverId, siteId, admin, detectionOn, timeZone, siteNames, onOpenSettings },
  ref,
) {
  const queryClient = useQueryClient();
  const { categorical } = useChartColors();
  const attacks = useAttacks(serverId, siteId);
  const blocked = useBlocked(serverId);
  const [busy, setBusy] = useState<string | null>(null);
  const summary = attacks.data;
  // The core keeps everything-together rows under the site id `*`.
  const siteName = (id: string | undefined) =>
    id && id !== '*' ? (siteNames.get(id) ?? id) : 'every site';

  const chart = useMemo(() => {
    const series = summary?.series ?? [];
    const step = series.length > 1 ? series[1].startUnixMs - series[0].startUnixMs : HOUR;
    return {
      granularity: step <= HOUR ? ('hour' as const) : ('day' as const),
      times: series.map((point) => point.startUnixMs),
      columns: series.map((point) => ATTACK_KINDS.map((kind) => point[kind.value])),
      any: series.some(
        (point) => point.scan + point.bruteForce + point.flood + point.injection > 0,
      ),
    };
  }, [summary]);
  const kinds = ATTACK_KINDS.map((kind) => ({
    key: kind.value,
    label: kind.label,
    color: categorical[KIND_SLOT[kind.value]],
  }));

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployTraffic(serverId) });
  }

  async function block(event: AttackEventInfo): Promise<void> {
    const confirmed = await confirmDialog({
      title: SECURITY_TEXT.blockTitle(event.address),
      description: SECURITY_TEXT.blockPreview(event.address),
      confirmLabel: SECURITY_TEXT.block,
      variant: 'destructive',
    });
    if (!confirmed) return;
    setBusy(event.address);
    try {
      const result = await window.runova.deployTraffic.block({
        serverId,
        network: event.address,
        reason: `${attackKindLabel(event.kind)} on ${siteName(event.siteId)}`,
        ...(event.siteId && event.siteId !== '*' ? { siteId: event.siteId } : {}),
      });
      if (result.problems.length > 0) {
        toast.error(result.problems.join(' '));
        return;
      }
      toast.success(SECURITY_TEXT.blockedToast(event.address));
      refresh();
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function unblock(entry: BlockedAddressInfo): Promise<void> {
    const confirmed = await confirmDialog({
      title: SECURITY_TEXT.unblockTitle(entry.network),
      description: SECURITY_TEXT.unblockBody,
      confirmLabel: SECURITY_TEXT.unblock,
    });
    if (!confirmed) return;
    setBusy(entry.network);
    try {
      await window.runova.deployTraffic.unblock({ serverId, blockId: entry.id });
      toast.success(SECURITY_TEXT.unblockedToast(entry.network));
      refresh();
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const events = summary?.events ?? [];
  const blocks = blocked.data ?? [];
  return (
    <div ref={ref} id="traffic-security" className="scroll-mt-4">
      <Card
        icon={<Shield />}
        title={SECURITY_TEXT.title}
        description={SECURITY_TEXT.description}
        tone={events.length > 0 ? 'destructive' : 'primary'}
        extra={
          summary && summary.addresses > 0 ? (
            <Chip tone="destructive">
              {summary.addresses} {summary.addresses === 1 ? 'address' : 'addresses'}
            </Chip>
          ) : undefined
        }
        actions={
          admin && onOpenSettings ? (
            <Button size="sm" variant="soft" onClick={onOpenSettings}>
              <Sliders /> {SECURITY_TEXT.settings}
            </Button>
          ) : undefined
        }
      >
        <div className={cn(CARD_BODY, 'space-y-4')}>
          {!detectionOn && (
            <Notice size="sm" tone="warning">
              {SECURITY_TEXT.detectionOff}
            </Notice>
          )}
          {attacks.isPending ? (
            <Skeleton className="h-28 w-full" aria-busy="true" />
          ) : attacks.isError ? (
            <p role="alert" className="text-sm text-muted-foreground">
              {coreErrorMessage(attacks.error)}
            </p>
          ) : chart.any ? (
            <StackedColumns
              title="Attacks over the last 7 days"
              times={chart.times}
              columns={chart.columns}
              series={kinds}
              formatValue={compactNumber}
              bucketLabel={(at) => bucketLabel(at, chart.granularity, timeZone)}
              axisLabel={(at) => axisLabel(at, chart.granularity, timeZone)}
              height={96}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{SECURITY_TEXT.noAttacks}</p>
          )}
        </div>
        {events.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" aria-label={SECURITY_TEXT.openAttacks}>
              <thead className="text-left">
                <tr className="shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]">
                  <th className={TABLE_HEAD}>Address</th>
                  <th className={TABLE_HEAD}>What</th>
                  <th className={TABLE_HEAD}>Requests</th>
                  <th className={TABLE_HEAD}>Seen</th>
                  <th className={TABLE_HEAD}>Tried</th>
                  <th className={TABLE_HEAD}>
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.slice(0, SHOWN_EVENTS).map((event) => (
                  <tr
                    key={event.id}
                    className="align-top [&>td]:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]"
                  >
                    <td className={TABLE_CELL}>
                      <span className="flex items-center gap-1.5 font-mono text-[12px]">
                        {event.country && (
                          <CountryFlag
                            countryCode={event.country}
                            className="h-2.5 w-[15px] shrink-0 rounded-[2px]"
                          />
                        )}
                        {event.address}
                      </span>
                      {event.country && (
                        <span className="text-[11px] text-muted-foreground">
                          {countryName(event.country)}
                        </span>
                      )}
                    </td>
                    <td className={TABLE_CELL}>
                      <span className="flex items-center gap-1.5">
                        <span
                          className="h-2 w-2 shrink-0 rounded-[2px]"
                          style={{ backgroundColor: categorical[KIND_SLOT[event.kind]] }}
                        />
                        {attackKindLabel(event.kind)}
                      </span>
                      {!siteId && (
                        <span className="text-[11px] text-muted-foreground">
                          on {siteName(event.siteId)}
                        </span>
                      )}
                    </td>
                    <td className={cn(TABLE_CELL, 'tabular-nums')}>{compactNumber(event.count)}</td>
                    <td className={cn(TABLE_CELL, 'whitespace-nowrap text-muted-foreground')}>
                      {ago(event.lastSeenAtUnixMs)}
                      <span className="block text-[11px]">
                        first {ago(event.firstSeenAtUnixMs)}
                      </span>
                    </td>
                    <td className={TABLE_CELL}>
                      <Paths paths={event.samplePaths} />
                    </td>
                    <td className={cn(TABLE_CELL, 'text-right')}>
                      {event.blocked ? (
                        <Chip tone="neutral">
                          <Ban /> {SECURITY_TEXT.blocked}
                        </Chip>
                      ) : admin ? (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy === event.address}
                          aria-label={`Block ${event.address}`}
                          onClick={() => void block(event)}
                        >
                          {busy === event.address ? (
                            <Spinner className="motion-safe:animate-spin" />
                          ) : (
                            <Ban />
                          )}
                          {SECURITY_TEXT.block}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className={cn(CARD_BODY, 'space-y-2')}>
          <h4 className={SECTION_HEADING}>{SECURITY_TEXT.blockedTitle}</h4>
          {blocked.isPending ? (
            <Skeleton className="h-8 w-full" />
          ) : blocks.length === 0 ? (
            <p className="text-xs text-muted-foreground">{SECURITY_TEXT.noneBlocked}</p>
          ) : (
            <ul aria-label={SECURITY_TEXT.blockedTitle} className="settings-rows">
              {blocks.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="font-mono text-[12px]">{entry.network}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {entry.reason}
                    {' · '}
                    {entry.automatic ? SECURITY_TEXT.automatic : (entry.createdBy ?? 'someone')}
                    {' · '}
                    {entry.expiresAtUnixMs
                      ? `ends ${fromNow(entry.expiresAtUnixMs)}`
                      : SECURITY_TEXT.forGood}
                  </span>
                  {admin && (
                    <Button
                      size="sm"
                      variant="soft"
                      disabled={busy === entry.network}
                      aria-label={`Unblock ${entry.network}`}
                      onClick={() => void unblock(entry)}
                    >
                      {SECURITY_TEXT.unblock}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
});
