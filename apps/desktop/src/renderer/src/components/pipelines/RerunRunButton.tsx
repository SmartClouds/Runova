import type { GithubWorkflowRunInfo } from '@shared/apiTypes';
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
import { RerunConfirmDialog, RERUN_SCOPES as SCOPES } from './RerunConfirmDialog';
import type { RerunScope } from './rerunPlan';

/** GitHub shows the new attempt within a few seconds, so look again soon rather than on the 30s tick. */
const START_POLL_MS = 3_000;
/** When GitHub never shows it, the button comes back instead of staying stuck on "Starting". */
const START_TIMEOUT_MS = 30_000;

/**
 * Starts a finished run again. A run with jobs that did not pass gets a menu with both choices, the
 * way GitHub offers them; any other run has only one choice, so it is a plain button. Either way it
 * asks first, in a dialog that lists the jobs that will run again.
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
  run: Pick<
    GithubWorkflowRunInfo,
    'id' | 'status' | 'runNumber' | 'runAttempt' | 'headBranch' | 'headSha'
  >;
  canRerunFailed: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const attempt = run.runAttempt ?? 1;
  const [sending, setSending] = useState(false);
  // The choice being confirmed. It outlives `asking`, so the dialog keeps its words as it fades out.
  const [scope, setScope] = useState<RerunScope>('all');
  const [asking, setAsking] = useState(false);
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

  function ask(choice: RerunScope): void {
    setScope(choice);
    setAsking(true);
  }

  async function rerun(): Promise<void> {
    const { sent } = SCOPES[scope];
    setAsking(false);
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

  const dialog = (
    <RerunConfirmDialog
      // A fresh dialog for each choice, so jobs folded open for one do not carry over to the other.
      key={scope}
      open={asking}
      onOpenChange={setAsking}
      scope={scope}
      repo={repo}
      workflowName={workflowName}
      run={run}
      onConfirm={() => void rerun()}
    />
  );

  if (!canRerunFailed) {
    return (
      <>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          disabled={busy}
          onClick={() => ask('all')}
        >
          {icon}
          {starting ? 'Starting' : SCOPES.all.label}
        </Button>
        {dialog}
      </>
    );
  }

  return (
    <>
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
          {(['all', 'failed'] as const).map((choice) => (
            <DropdownMenuItem key={choice} onSelect={() => ask(choice)}>
              <span className="flex flex-col">
                <span className="text-[13px] font-medium">{SCOPES[choice].label}</span>
                <span className="text-[11px] text-muted-foreground">{SCOPES[choice].hint}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}
