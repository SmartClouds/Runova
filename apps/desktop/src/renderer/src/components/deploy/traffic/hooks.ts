import type { TrafficGranularity } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { type CustomDays, rangeWindow, type TrafficRange } from '@shared/deploy/trafficRanges';
import type { DeployTrafficLiveEvent } from '@shared/deployTrafficTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ownedSubscription } from '@/lib/deploy/overview/subscription';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The Traffic section's data (E109, E110). A report is keyed by what the person picked, not by the
 * exact moments, so "Today" stays one cached report that refreshes once a minute; while a new one
 * loads the old one stays on screen, dimmed. Live visitors come every five seconds and only change
 * state when the numbers do, so a quiet server does not re-render the report.
 */

const MINUTE = 60_000;

export function useTrafficStatus(serverId: string) {
  return useQuery({
    queryKey: queryKeys.deployTrafficStatus(serverId),
    queryFn: () => window.runova.deployTraffic.status(serverId),
    retry: false,
    staleTime: 30_000,
  });
}

export interface ReportView {
  siteId: string | null;
  range: TrafficRange;
  custom?: CustomDays;
  granularity: TrafficGranularity;
  compare: boolean;
  timeZone: string;
}

export function useTrafficReport(serverId: string, view: ReportView, enabled = true) {
  return useQuery({
    queryKey: queryKeys.deployTrafficReport(serverId, { ...view }),
    queryFn: () => {
      const window_ = rangeWindow(view.range, Date.now(), view.timeZone, view.custom);
      return window.runova.deployTraffic.report({
        serverId,
        ...(view.siteId ? { siteId: view.siteId } : {}),
        fromUnixMs: window_.from,
        toUnixMs: window_.to,
        granularity: view.granularity,
        compare: view.compare,
      });
    },
    enabled,
    retry: false,
    staleTime: 30_000,
    refetchInterval: MINUTE,
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
  });
}

export function useAttacks(serverId: string, siteId: string | null) {
  return useQuery({
    queryKey: queryKeys.deployTrafficAttacks(serverId, siteId),
    queryFn: () =>
      window.runova.deployTraffic.attacks({
        serverId,
        ...(siteId ? { siteId } : {}),
        limit: 200,
      }),
    retry: false,
    staleTime: 30_000,
    refetchInterval: MINUTE,
    placeholderData: (previous) => previous,
  });
}

export function useBlocked(serverId: string) {
  return useQuery({
    queryKey: queryKeys.deployTrafficBlocked(serverId),
    queryFn: () => window.runova.deployTraffic.blocked(serverId),
    retry: false,
    staleTime: 30_000,
  });
}

export interface LiveReading {
  visitorsNow: number;
  requestsLastMinute: number;
}

/** Live visitors for one site or all of them; null until the first reading. */
export function useTrafficLive(
  serverId: string,
  siteId: string | null,
  enabled: boolean,
): LiveReading | null {
  const [reading, setReading] = useState<LiveReading | null>(null);

  useEffect(() => {
    setReading(null);
    if (!enabled) return undefined;
    const api = window.runova.deployTraffic;
    return ownedSubscription<DeployTrafficLiveEvent>({
      listen: (callback) => api.onLive(callback),
      start: () => api.watchLive({ serverId, siteId }),
      stop: (id) => api.unwatchLive(id),
      onEvent: (event) => {
        const live = event.live;
        if (!live) {
          setReading(null);
          return;
        }
        setReading((current) =>
          current &&
          current.visitorsNow === live.visitorsNow &&
          current.requestsLastMinute === live.requestsLastMinute
            ? current
            : { visitorsNow: live.visitorsNow, requestsLastMinute: live.requestsLastMinute },
        );
      },
      // Live visitors are a nicety: the report reads fine without them.
      onError: () => setReading(null),
    });
  }, [serverId, siteId, enabled]);

  return reading;
}
