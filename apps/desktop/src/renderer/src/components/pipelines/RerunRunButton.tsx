import type { GithubRunRerunRequest, GithubWorkflowRunInfo } from '@shared/apiTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, RotateCw, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';

type RerunScope = GithubRunRerunRequest['scope'];

/** GitHub shows the new attempt within a few seconds, so look again soon rather than on the 30s tick. */
const START_POLL_MS = 3_000;
/** When GitHub never shows it, the button comes back instead of staying stuck on "Starting". */
const START_TIMEOUT_MS = 30_000;

const SCOPES: Record<
  RerunScope,
  { label: string; hint: string; sent: string; explain: (runNumber: number) => string }
> = {
  all: {
    label: 'Re-run all jobs',
    hint: 'Every job, including the ones that passed',
    sent: 'Asked GitHub to re-run all jobs.',
    explain: (runNumber) =>
      `Every job in run #${runNumber} starts again on the same commit, including the ones that passed. Anything this pipeline deploys or publishes happens again.`,
  },
  failed: {
    label: 'Re-run failed jobs',
    hint: 'Only failed jobs and the ones that need them',
    sent: 'Asked GitHub to re-run the failed jobs.',
    explain: (runNumber) =>
      `The jobs in run #${runNumber} that failed or were cancelled start again on the same commit, along with any jobs that depend on them.`,
  },
};

/**
 * Starts a finished run again. A run with jobs that did not pass gets a menu with both choices, the
 * way GitHub offers them; any other run has only one choice, so it is a plain button.
 */
export function RerunRunButton({
  projectId,
  repo,
  workflowName,
  run,
  canRerunFailed,
}: {
  projectId: string;
  repo: string;
  workflowName: string;
  run: Pick<GithubWorkflowRunInfo, 'id' | 'runNumber' | 'runAttempt'>;
  canRerunFailed: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const attempt = run.runAttempt ?? 1;
  const [sending, setSending] = useState(false);
  // The attempt that was on screen when GitHub accepted. Once a newer one shows up this stops
  // matching, so nothing has to reset it, and until then a second click would only be refused.
  const [startedFrom, setStartedFrom] = useState<number | null>(null);
  const starting = startedFrom === attempt;

  useEffect(() => {
    if (!starting) return;
    const poll = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pipelineStatus(projectId) });
    }, START_POLL_MS);
    const giveUp = setTimeout(() => setStartedFrom(null), START_TIMEOUT_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [starting, projectId, queryClient]);

  async function rerun(scope: RerunScope): Promise<void> {
    const { label, sent, explain } = SCOPES[scope];
    const confirmed = await confirmDialog({
      title: `${label} of ${workflowName}?`,
      description: explain(run.runNumber),
      confirmLabel: label,
    });
    if (!confirmed) return;

    setSending(true);
    try {
      const result = await window.runova.pipelines.rerunRun({ repo, runId: run.id, scope });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(sent);
      setStartedFrom(attempt);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not re-run that workflow.');
    } finally {
      setSending(false);
    }
  }

  const busy = sending || starting;
  const icon = busy ? (
    <Spinner className="animate-spin motion-reduce:animate-none" />
  ) : (
    <RotateCw />
  );

  if (!canRerunFailed) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        disabled={busy}
        onClick={() => void rerun('all')}
      >
        {icon}
        {starting ? 'Starting' : SCOPES.all.label}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          disabled={busy}
        >
          {icon}
          {starting ? 'Starting' : 'Re-run jobs'}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" collisionPadding={8} className="w-[17rem]">
        {(['all', 'failed'] as const).map((scope) => (
          <DropdownMenuItem key={scope} onSelect={() => void rerun(scope)}>
            <span className="flex flex-col">
              <span className="text-[13px] font-medium">{SCOPES[scope].label}</span>
              <span className="text-[11px] text-muted-foreground">{SCOPES[scope].hint}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
