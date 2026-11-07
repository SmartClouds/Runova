import type { AiAuditRunSummary } from '@runova/core';
import { AI_AUDIT_PHASE_STEPS, completedAuditSteps } from '@runova/core';
import { useEffect, useState } from 'react';
import { Check, Spinner, TerminalSquare, TriangleAlert } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * A running audit, as the agent's files describe it. The run can take an hour, so the card says
 * where it is (the six phases), how far through the plan it is (coverage units), and when it last
 * wrote anything, which is how a working run is told apart from one that died with its tab.
 */

/** Past this with no new file, the run is probably not working any more. */
const STALLED_AFTER_MS = 30 * 60_000;

function minutes(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  if (total < 1) return 'less than a minute';
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function AuditRunTracker({
  run,
  onOpenAgent,
  onStopTracking,
}: {
  run: AiAuditRunSummary;
  onOpenAgent: () => void;
  onStopTracking: () => void;
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  // Minute resolution is all the "last update" line needs.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const done = completedAuditSteps(run.phase);
  const starting = run.phase === 'starting';
  const quietFor = now - new Date(run.lastActivityAt).getTime();
  const stalled = !starting && quietFor > STALLED_AFTER_MS;
  const coverage =
    run.ledger && run.ledger.total > 0
      ? Math.round((run.ledger.settled / run.ledger.total) * 100)
      : null;

  return (
    <Card className="glass">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <Spinner className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-primary" />
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                AI security audit in progress
                <Badge variant="outline">{run.runName}</Badge>
                {run.metadata?.profile && (
                  <Badge variant="secondary" className="capitalize">
                    {run.metadata.profile}
                  </Badge>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {starting
                  ? 'Waiting for the agent to start. It loads the skill, then writes its first files here.'
                  : `Running for ${minutes(now - new Date(run.startedAt).getTime())} · Last update ${minutes(quietFor)} ago`}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onOpenAgent}>
              <TerminalSquare className="h-3.5 w-3.5" /> Open agent tab
            </Button>
            <Button variant="ghost" size="sm" onClick={onStopTracking}>
              Stop tracking
            </Button>
          </div>
        </div>

        <ol
          className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
          aria-label="Audit phases"
        >
          {AI_AUDIT_PHASE_STEPS.map((step, index) => {
            const state =
              index < done ? 'done' : index === done && !starting ? 'current' : 'upcoming';
            const stateLabel =
              state === 'done' ? 'done' : state === 'current' ? 'in progress' : 'not started';
            return (
              <li
                key={step.id}
                aria-label={`${step.label}, ${stateLabel}`}
                aria-current={state === 'current' ? 'step' : undefined}
                className={cn(
                  'rounded-lg border px-2.5 py-2 transition-colors',
                  state === 'done' && 'border-success/30 bg-success/5',
                  state === 'current' && 'border-primary/50 bg-primary/10',
                  state === 'upcoming' && 'border-border bg-card/40 opacity-70',
                )}
                title={step.description}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  {state === 'done' ? (
                    <Check className="h-3 w-3 shrink-0 text-success" />
                  ) : (
                    <span
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] tabular-nums',
                        state === 'current'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground',
                      )}
                      aria-hidden
                    >
                      {index + 1}
                    </span>
                  )}
                  <span className="truncate">{step.label}</span>
                </span>
              </li>
            );
          })}
        </ol>

        {coverage !== null && run.ledger && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {run.ledger.settled} of {run.ledger.total} coverage units done
              </span>
              <span className="tabular-nums">{coverage}%</span>
            </div>
            <div
              role="progressbar"
              aria-label="Coverage"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={coverage}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${coverage}%` }}
              />
            </div>
          </div>
        )}

        {stalled && (
          <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            Nothing has changed for {minutes(quietFor)}. The agent may have stopped or be waiting
            for you to approve something. Check its tab.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
