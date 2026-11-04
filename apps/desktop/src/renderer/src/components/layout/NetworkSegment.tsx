import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CountryFlag } from '@/components/CountryFlag';
import { SparklineChart } from '@/components/dashboard/SparklineChart';
import { RefreshCw, TriangleAlert, Wifi } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import type { SystemStatsSample } from '@/hooks/useSystemStatsHistory';
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { focusPanel, PanelTitle, PopSegment } from './statusBarKit';

/** The public address rarely moves mid-session, and main caches it for this long as well. */
const PUBLIC_IP_STALE_MS = 5 * 60_000;
/** A refresh that answers at once still turns the icon long enough to read as one. */
const MIN_SPIN_MS = 600;
const MAX_LOCAL_ADDRESSES = 3;

type Tone = 'good' | 'warn' | 'bad';

// The hover color is spelled out, since the segment's own hover would turn it plain.
const TONE_TEXT: Record<Tone, string> = {
  good: 'text-success hover:text-success',
  warn: 'text-warning hover:text-warning',
  bad: 'text-destructive hover:text-destructive',
};
const TONE_DOT: Record<Tone, string> = {
  good: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-destructive',
};

/** What the latest pings and the recent window say about the connection. */
export function describeNetwork(history: SystemStatsSample[]) {
  const pings = history.at(-1)?.pings ?? [];
  const alive = pings.filter((p) => p.alive);
  const latencies = alive.flatMap((p) => (p.latencyMs == null ? [] : [p.latencyMs]));
  const latency = latencies.length ? Math.round(Math.min(...latencies)) : null;
  // Quality over the recent window, so one dropped ping does not flash the bar red.
  const recent = history.flatMap((sample) => sample.pings ?? []);
  const quality = recent.length ? recent.filter((p) => p.alive).length / recent.length : 1;
  const online = pings.length === 0 || alive.length > 0;
  // Plenty of networks drop ping while the connection works, so no replies only reads as
  // offline when the OS agrees.
  const offline = !online && !navigator.onLine;
  const tone: Tone = offline
    ? 'bad'
    : !online || quality < 0.8 || (latency ?? 0) > 250
      ? 'warn'
      : 'good';
  const headline = offline ? 'Offline' : online ? 'Online' : 'Connected, but pings get no reply';
  const short = offline
    ? 'Offline'
    : !online
      ? 'No ping'
      : latency != null
        ? `${latency} ms`
        : 'Online';
  return { pings, latency, quality, online, offline, tone, headline, short };
}

/** The best reply in each sample, with a gap where nothing answered. */
function latencySeries(history: SystemStatsSample[]): number[] {
  return history.map((sample) => {
    const replies = (sample.pings ?? []).flatMap((p) =>
      p.alive && p.latencyMs != null ? [p.latencyMs] : [],
    );
    return replies.length ? Math.min(...replies) : Number.NaN;
  });
}

function SectionLabel({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-1 flex h-6 items-center justify-between gap-2">
      <p className="text-[10px] font-medium text-muted-foreground">{children}</p>
      {action}
    </div>
  );
}

function AddressRow({
  kind,
  address,
  detail,
  copyLabel,
}: {
  kind: string;
  address: string;
  detail?: React.ReactNode;
  copyLabel: string;
}): React.JSX.Element {
  return (
    <div className="flex h-6 items-center gap-2">
      <span className="w-11 shrink-0 text-[10px] text-muted-foreground">{kind}</span>
      <span className="min-w-0 truncate font-mono text-[11px] font-medium">{address}</span>
      {detail ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[10px] text-muted-foreground">
          {detail}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      <CopyButton text={address} label={copyLabel} alwaysVisible className="h-5 w-5" />
    </div>
  );
}

/**
 * The machine's public address (with its country) and its LAN addresses. Only mounted while the
 * panel is open, so the bar itself never goes looking. The refresh button skips main's cache, so
 * it really asks again, which is what you want after switching VPN or network.
 */
function IpAddresses(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const publicQuery = useQuery({
    queryKey: queryKeys.ipGeo,
    queryFn: () => window.runova.ipGeo.lookup(false),
    staleTime: PUBLIC_IP_STALE_MS,
    retry: false,
    meta: { silentLoading: true },
  });
  const localQuery = useQuery({
    queryKey: queryKeys.localAddresses,
    queryFn: () => window.runova.remote.listInterfaces(),
    staleTime: PUBLIC_IP_STALE_MS,
    meta: { silentLoading: true },
  });

  const busy = refreshing || publicQuery.isFetching || localQuery.isFetching;
  const refresh = (): void => {
    if (busy) return;
    setRefreshing(true);
    void Promise.allSettled([
      queryClient.fetchQuery({
        queryKey: queryKeys.ipGeo,
        queryFn: () => window.runova.ipGeo.lookup(true),
        staleTime: 0,
        retry: false,
        meta: { silentLoading: true },
      }),
      localQuery.refetch(),
      new Promise((resolve) => setTimeout(resolve, MIN_SPIN_MS)),
    ]).finally(() => setRefreshing(false));
  };

  const info = publicQuery.data;
  const locals = (localQuery.data ?? []).slice(0, MAX_LOCAL_ADDRESSES);
  const checkedAt = publicQuery.dataUpdatedAt || publicQuery.errorUpdatedAt;
  const refreshLabel = 'Refresh IP address';

  return (
    <div className="mt-3 border-t border-border/60 pt-2">
      <SectionLabel
        action={
          <SimpleTooltip label={refreshLabel} side="top">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={refreshLabel}
              // aria-disabled rather than disabled, so focus stays on the button while it works.
              aria-disabled={busy}
              aria-busy={busy}
              onClick={refresh}
            >
              <RefreshCw className={cn(busy && 'motion-safe:animate-spin')} />
            </Button>
          </SimpleTooltip>
        }
      >
        IP address
      </SectionLabel>

      {publicQuery.isPending ? (
        <div className="flex h-6 items-center gap-2">
          <span className="w-11 shrink-0 text-[10px] text-muted-foreground">Public</span>
          <span className="shimmer h-3 w-28 rounded" />
        </div>
      ) : info?.ip && !publicQuery.isError ? (
        <AddressRow
          kind="Public"
          address={info.ip}
          copyLabel="Copy public IP"
          detail={
            info.countryCode || info.country ? (
              <>
                <CountryFlag
                  countryCode={info.countryCode}
                  className="h-2.5 w-[0.9375rem] shrink-0 rounded-[1px]"
                />
                <span className="truncate">{info.country}</span>
              </>
            ) : null
          }
        />
      ) : (
        <div className="flex h-6 items-center gap-2">
          <span className="w-11 shrink-0 text-[10px] text-muted-foreground">Public</span>
          <TriangleAlert className="h-2.5 w-2.5 shrink-0 text-warning" />
          <span className="text-[11px] text-muted-foreground">
            {navigator.onLine ? "Couldn't look it up" : 'Unavailable while offline'}
          </span>
        </div>
      )}

      {localQuery.isPending ? (
        <div className="flex h-6 items-center gap-2">
          <span className="w-11 shrink-0 text-[10px] text-muted-foreground">Local</span>
          <span className="shimmer h-3 w-24 rounded" />
        </div>
      ) : locals.length > 0 ? (
        locals.map((iface) => (
          <AddressRow
            key={`${iface.name}:${iface.address}`}
            kind="Local"
            address={iface.address}
            detail={<span className="truncate">{iface.name}</span>}
            copyLabel={`Copy local IP ${iface.address}`}
          />
        ))
      ) : (
        <div className="flex h-6 items-center gap-2">
          <span className="w-11 shrink-0 text-[10px] text-muted-foreground">Local</span>
          <span className="text-[11px] text-muted-foreground">No network adapter connected</span>
        </div>
      )}

      {checkedAt ? (
        <p className="mt-1 text-[10px] text-muted-foreground">
          Checked {timeAgo(new Date(checkedAt).toISOString())}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Ping in the status bar. The bar shows the best latency, colored by how the connection is
 * doing, and a click opens the detail: latency over the last minute or so, each host pinged, and
 * the machine's public and local IP addresses.
 */
export function NetworkSegment({ history }: { history: SystemStatsSample[] }): React.JSX.Element {
  const net = describeNetwork(history);
  const series = latencySeries(history);
  const hasLatency = series.some(Number.isFinite);
  const answered = `${Math.round(net.quality * 100)}% of recent pings answered`;

  return (
    <PopSegment
      label="Network"
      tooltip={`Network: ${net.short}`}
      width="w-80"
      onOpenAutoFocus={focusPanel}
      className={TONE_TEXT[net.tone]}
      panel={
        <>
          <PanelTitle
            title={net.latency != null ? `Ping ${net.latency} ms` : 'Network'}
            detail={
              <span className="flex items-center gap-1.5">
                <span className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[net.tone])} />
                {net.headline}
              </span>
            }
          />
          {hasLatency ? (
            <SparklineChart
              timestamps={history.map((sample) => sample.timestamp)}
              series={[
                {
                  key: 'latency',
                  label: 'Ping',
                  color: 'hsl(var(--primary))',
                  values: series,
                },
              ]}
              height={56}
              domainMin={0}
              formatValue={(value) => `${Math.round(value)} ms`}
            />
          ) : null}
          {net.pings.length > 0 ? (
            <div className="mt-2">
              <SectionLabel>
                {answered}
                {net.pings.some((ping) => /^https?:\/\//i.test(ping.host))
                  ? ', measured with URL requests'
                  : ''}
              </SectionLabel>
              {net.pings.map((ping) => (
                <div key={ping.host} className="flex h-5 items-center gap-2">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      ping.alive ? 'bg-success' : 'bg-destructive',
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{ping.host}</span>
                  <span
                    className={cn(
                      'shrink-0 text-[10px] tabular-nums',
                      ping.alive ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {ping.alive ? `${Math.round(ping.latencyMs ?? 0)} ms` : 'no reply'}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <IpAddresses />
        </>
      }
    >
      <Wifi className="h-2.5 w-2.5" />
      <span className="tabular-nums">{net.short}</span>
    </PopSegment>
  );
}
