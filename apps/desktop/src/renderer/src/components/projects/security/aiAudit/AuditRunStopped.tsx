import type { AiAuditRunSummary } from '@runova/core';
import { AI_AUDIT_PHASE_STEPS, completedAuditSteps } from '@runova/core';
import { FolderOpen, Plus, StopCircle, TerminalSquare, TriangleAlert } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/** One thing worth knowing about where a stopped run got to. */
function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card/40 px-3 py-2">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

/** A run the user stopped: its agent is gone, and what it wrote is still in the run folder. */
export function AuditRunStopped({
  run,
  onNewAudit,
  onOpenFolder,
}: {
  run: AiAuditRunSummary;
  onNewAudit: () => void;
  onOpenFolder: () => void;
}): React.JSX.Element {
  const reached =
    run.phase === 'starting'
      ? 'Startup'
      : (AI_AUDIT_PHASE_STEPS[completedAuditSteps(run.phase)]?.label ?? 'Unknown');
  const coverage =
    run.ledger && run.ledger.total > 0
      ? `${run.ledger.settled} of ${run.ledger.total} units`
      : 'Not planned yet';

  return (
    <Card className="glass">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <StopCircle className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                Audit stopped
                <Badge variant="outline">{run.runName}</Badge>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                The agent was closed before it finished, so this run has no report. What it wrote so
                far is still in the run folder.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onOpenFolder}>
              <FolderOpen className="h-3.5 w-3.5" /> Open run folder
            </Button>
            <Button size="sm" className="gap-1.5" onClick={onNewAudit}>
              <Plus className="h-3.5 w-3.5" /> Start a new audit
            </Button>
          </div>
        </div>

        <dl className="grid gap-2 sm:grid-cols-3">
          <Fact label="Stopped during" value={reached} />
          <Fact label="Coverage" value={coverage} />
          <Fact label="Last activity" value={new Date(run.lastActivityAt).toLocaleString()} />
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * A run nobody is following whose agent could not be stopped from here, because Runova does not
 * know which tab it is in. It says so rather than implying the agent has gone.
 */
export function AuditRunUntracked({
  run,
  onOpenAgent,
  onKeepTracking,
}: {
  run: AiAuditRunSummary;
  onOpenAgent: () => void;
  onKeepTracking: () => void;
}): React.JSX.Element {
  return (
    <Card className="glass border-warning/40">
      <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning">
            <TriangleAlert className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
              This audit may still be running
              <Badge variant="outline">{run.runName}</Badge>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Runova can't tell which tab its agent is in, so it could not stop it. To end the run,
              close the agent's tab in the workspace.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onKeepTracking}>
            Keep tracking
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onOpenAgent}>
            <TerminalSquare className="h-3.5 w-3.5" /> Open agent tab
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
