import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, RefreshCw, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Where the plan stands against its remote (E123). Plan changes are committed on their own, but
 * pushing them and pulling a teammate's or another computer's stays the person's call, from here.
 */
export function PlanSyncStrip({ projectId }: { projectId: string }): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'fetch' | 'pull' | 'push' | null>(null);
  const status = useQuery({
    queryKey: queryKeys.gitStatus(projectId),
    queryFn: () => window.runova.git.status(projectId),
    staleTime: 30_000,
  });
  const data = status.data;
  if (!data?.isRepo || !data.hasRemote) return null;

  async function run(kind: 'fetch' | 'pull' | 'push'): Promise<void> {
    setBusy(kind);
    try {
      const result = await window.runova.git[kind](projectId);
      if (!result.ok) {
        toast.error(
          kind === 'pull'
            ? 'Could not pull'
            : kind === 'push'
              ? 'Could not push'
              : 'Could not check',
          { description: result.message },
        );
      } else if (kind !== 'fetch') {
        toast.success(kind === 'pull' ? 'Pulled the latest plan' : 'Pushed the plan');
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(projectId) });
      if (kind === 'pull') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.relayBoard(projectId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.relayPlanPack(projectId) });
      }
    } finally {
      setBusy(null);
    }
  }

  const spin = (kind: typeof busy) => (busy === kind ? <Spinner className="animate-spin" /> : null);
  return (
    <div
      role="status"
      aria-label="Plan sync"
      className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground"
    >
      {data.behind > 0 ? (
        <>
          <span>
            {data.behind} new commit{data.behind === 1 ? '' : 's'} on {data.branch ?? 'the branch'}
          </span>
          <Button
            type="button"
            size="sm"
            variant="tint"
            disabled={busy !== null}
            onClick={() => void run('pull')}
          >
            {spin('pull') ?? <ArrowDown />} Pull
          </Button>
        </>
      ) : null}
      {data.ahead > 0 ? (
        <>
          <span>
            {data.ahead} commit{data.ahead === 1 ? '' : 's'} not pushed
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void run('push')}
          >
            {spin('push') ?? <ArrowUp />} Push
          </Button>
        </>
      ) : null}
      {data.behind === 0 && data.ahead === 0 ? <span>Up to date with the remote</span> : null}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Check the remote for plan changes"
        disabled={busy !== null}
        onClick={() => void run('fetch')}
      >
        {spin('fetch') ?? <RefreshCw />}
      </Button>
    </div>
  );
}
