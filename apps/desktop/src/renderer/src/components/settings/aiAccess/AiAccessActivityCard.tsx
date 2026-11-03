import type { AiAccessActivityEntry, AiActivityOutcome } from '@shared/aiAccessTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { History } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';

/**
 * Settings > AI access > Recent activity: what agents read and changed through AI access, and what
 * the user allowed or denied, newest first. New calls appear as they happen.
 */

const OUTCOME: Record<
  AiActivityOutcome,
  { label: string; variant: 'success' | 'secondary' | 'warning' | 'destructive' | 'outline' }
> = {
  auto: { label: 'Ran', variant: 'secondary' },
  approved: { label: 'Approved', variant: 'success' },
  denied: { label: 'Denied', variant: 'destructive' },
  timeout: { label: 'Timed out', variant: 'warning' },
  failed: { label: 'Failed', variant: 'destructive' },
  refused: { label: 'Refused', variant: 'outline' },
};

const SHOWN = 30;

export function AiAccessActivityCard(): React.JSX.Element {
  const queryClient = useQueryClient();
  const activity = useQuery({
    queryKey: queryKeys.aiAccessActivity,
    queryFn: () => window.runova.aiAccess.activity(),
  });

  useEffect(
    () =>
      window.runova.aiAccess.onActivity((entry) => {
        queryClient.setQueryData<AiAccessActivityEntry[]>(queryKeys.aiAccessActivity, (list) => [
          entry,
          ...(list ?? []).filter((one) => one.id !== entry.id),
        ]);
      }),
    [queryClient],
  );

  async function clear(): Promise<void> {
    await window.runova.aiAccess.clearActivity();
    queryClient.setQueryData(queryKeys.aiAccessActivity, []);
  }

  const entries = activity.data ?? [];

  return (
    <Card className="glass">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <History className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>What agents did through AI access on this machine.</CardDescription>
          </div>
        </div>
        {entries.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => void clear()}>
            Clear
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3.5 py-6 text-center text-xs text-muted-foreground">
            {activity.isLoading
              ? 'Loading…'
              : 'Nothing yet. What agents do through AI access shows up here.'}
          </p>
        ) : (
          <ul className="max-h-96 divide-y divide-border/70 overflow-y-auto rounded-lg border border-border bg-background/40">
            {entries.slice(0, SHOWN).map((entry) => {
              const outcome = OUTCOME[entry.outcome];
              return (
                <li key={entry.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{entry.toolTitle}</p>
                    <p
                      className="truncate text-xs text-muted-foreground"
                      title={entry.detail ?? undefined}
                    >
                      {entry.agent}
                      {entry.projectName ? ` · ${entry.projectName}` : ''}
                      {entry.detail ? ` · ${entry.detail}` : ''}
                    </p>
                  </div>
                  <Badge variant={outcome.variant} className="font-normal">
                    {outcome.label}
                  </Badge>
                  <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">
                    {timeAgo(new Date(entry.at).toISOString())}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
