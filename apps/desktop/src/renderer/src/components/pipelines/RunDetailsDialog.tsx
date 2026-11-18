import type { Project } from '@runova/core';
import type { GithubActionsHistoryItem, GithubWorkflowRunInfo } from '@shared/apiTypes';
import { Github } from '@/components/icons';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { RunDetails } from '@/components/workspace/git/RunDetails';

/** A run from the Pipelines page's history, in the shape the run details read. */
export function historyItemToRun(
  item: GithubActionsHistoryItem & { workflowId: number },
): GithubWorkflowRunInfo {
  return {
    id: item.id,
    workflowId: item.workflowId,
    name: item.workflowName,
    displayTitle: item.displayTitle,
    runNumber: item.runNumber,
    headBranch: item.headBranch,
    status: item.status,
    conclusion: item.conclusion,
    htmlUrl: item.htmlUrl,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * One run's details from the Pipelines page, the same view the workspace's pipelines dialog has:
 * its jobs and steps, how long each usually takes, and what it left behind. The page keeps the
 * run's row fresh, so a live run here moves along with it.
 */
export function RunDetailsDialog({
  item,
  project,
  open,
  onOpenChange,
}: {
  item: GithubActionsHistoryItem & { workflowId: number };
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const run = historyItemToRun(item);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        tabIndex={-1}
        // Focus the dialog itself: landing on the first button would pop its tooltip.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        className="flex h-[min(52rem,88vh)] max-h-[88vh] w-[calc(100vw-2rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0 outline-none sm:rounded-2xl"
      >
        <div className="flex h-14 shrink-0 items-center gap-2 pl-5 pr-14 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <Github className="h-3.5 w-3.5" />
          </span>
          <DialogTitle className="text-sm font-semibold">{`${item.workflowName} #${item.runNumber}`}</DialogTitle>
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {item.repo}
          </span>
          <DialogDescription className="sr-only">
            The jobs and steps of this run, with how long each one usually takes.
          </DialogDescription>
        </div>
        <RunDetails
          key={`${item.repo}:${item.id}`}
          project={project}
          repo={item.repo}
          workflow={{ id: item.workflowId, name: item.workflowName, htmlUrl: item.htmlUrl }}
          run={run}
        />
      </DialogContent>
    </Dialog>
  );
}
