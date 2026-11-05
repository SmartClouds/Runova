import type { AccountStatus } from '@shared/accountTypes';
import type { SyncOverview } from '@shared/syncTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The account on this computer and its sync, kept current by main's change events, so the Account
 * page and the status bar agree without polling.
 */
export function useAccountStatus() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.accountStatus,
    queryFn: () => window.runova.account.status(),
  });
  useEffect(
    () =>
      window.runova.account.onChanged((status: AccountStatus) => {
        client.setQueryData(queryKeys.accountStatus, status);
        void client.invalidateQueries({ queryKey: ['account'], exact: false });
        void client.invalidateQueries({ queryKey: queryKeys.syncOverview });
      }),
    [client],
  );
  return query;
}

export function useSyncOverview(enabled = true) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.syncOverview,
    queryFn: () => window.runova.sync.overview(),
    enabled,
  });
  useEffect(
    () =>
      window.runova.sync.onChanged((overview: SyncOverview) => {
        client.setQueryData(queryKeys.syncOverview, overview);
        if (overview.conflicts > 0)
          void client.invalidateQueries({ queryKey: queryKeys.syncConflicts });
      }),
    [client],
  );
  return query;
}

/** "3 minutes ago", "yesterday", "just now". */
export function relativeTime(at: string | number, now = Date.now()): string {
  const seconds = Math.round(((typeof at === 'number' ? at : Date.parse(at)) - now) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

/** The message of a refusal from main, without Electron's "Error invoking remote method" prefix. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
