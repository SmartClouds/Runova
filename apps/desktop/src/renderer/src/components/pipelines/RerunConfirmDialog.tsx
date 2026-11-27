import type { GithubRunJob, GithubWorkflowRunInfo } from '@shared/apiTypes';
import { useId, useRef, useState } from 'react';
import { ChevronRight, RotateCw, TriangleAlert } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { type PlannedJob, planRerun, type RerunScope } from './rerunPlan';
import { RunStatusIcon, runTone, StepGlyph, spanDuration } from './runStatus';
import { useRunDetails } from './useRunDetails';

/** The words for each way of re-running, shared by the button that offers them and this dialog. */
export const RERUN_SCOPES: Record<
  RerunScope,
  { label: string; hint: string; sent: string; explain: (runNumber: number) => string }
> = {
  all: {
    label: 'Re-run all jobs',
    hint: 'Every job, including the ones that passed',
    sent: 'Asked GitHub to re-run all jobs.',
    explain: (runNumber) =>
      `Every job in run #${runNumber} starts again on the same commit, including the ones that passed.`,
  },
  failed: {
    label: 'Re-run failed jobs',
    hint: 'Only failed jobs and the ones that need them',
    sent: 'Asked GitHub to re-run the failed jobs.',
    explain: (runNumber) =>
      `The jobs in run #${runNumber} that failed or were cancelled start again on the same commit, along with any jobs that depend on them.`,
  },
};

const DEPLOY_WARNING = 'Anything this pipeline deploys or publishes happens again.';

type RerunRun = Pick<
  GithubWorkflowRunInfo,
  'id' | 'status' | 'runAttempt' | 'runNumber' | 'headBranch' | 'headSha'
>;

function jobs(count: number): string {
  return `${count} job${count === 1 ? '' : 's'}`;
}

/** How long a job took last time. A skipped one never ran, so it has no time. */
function took(job: GithubRunJob): string {
  return job.conclusion === 'skipped' ? '' : spanDuration(job.startedAt, job.completedAt);
}

function SectionHeading({
  title,
  count,
  hint,
}: {
  title: string;
  count: number;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className="space-y-0.5 px-0.5">
      <h3 className="flex items-center gap-2 text-xs font-semibold text-foreground/90">
        {title}
        <span className="rounded-full bg-foreground/[0.07] px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
      </h3>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** A job that runs again, folding open onto the steps that run with it. */
function JobRow({
  entry,
  open,
  onToggle,
}: {
  entry: PlannedJob;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const stepsId = useId();
  const { job, failedStep } = entry;
  const tone = runTone(job);
  const duration = took(job);
  const failed = tone.outcome === 'failed';
  const count = job.steps.length;

  return (
    <li
      className={cn(
        // Rings, not borders: the theme's global border colour would hide the tint.
        'rounded-xl ring-1 ring-inset',
        failed
          ? 'bg-destructive/[0.04] ring-destructive/20'
          : 'bg-foreground/[0.025] ring-foreground/[0.08]',
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={stepsId}
        aria-label={[job.name, tone.label, duration ? `took ${duration}` : '']
          .filter(Boolean)
          .join(', ')}
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-left outline-none transition-colors hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
        <RunStatusIcon tone={tone} className="h-6 w-6 rounded-md" />
        <span className="min-w-0 flex-1 break-words text-[13px] font-medium">{job.name}</span>
        <Badge variant={tone.variant} className="shrink-0 px-2 py-0 text-[10px]">
          {tone.label}
        </Badge>
        {duration ? (
          <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
            {duration}
          </span>
        ) : null}
      </button>
      {open ? (
        <div id={stepsId} className="space-y-1 px-2 pb-2">
          {count === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              GitHub lists no steps for this job.
            </p>
          ) : (
            <>
              <ol aria-label={`${job.name} steps`} className="space-y-px">
                {job.steps.map((step) => {
                  const stepTone = runTone(step);
                  const here = step.number === failedStep?.number;
                  const muted = stepTone.outcome === 'cancelled' || stepTone.label === 'Skipped';
                  return (
                    <li
                      key={step.number}
                      className={cn(
                        'flex items-center gap-2.5 rounded-lg px-2 py-1 text-xs',
                        here && 'bg-destructive/[0.06] ring-1 ring-inset ring-destructive/20',
                        muted && 'text-muted-foreground/70',
                      )}
                    >
                      <StepGlyph tone={stepTone} />
                      <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/70">
                        {step.number}
                      </span>
                      <span className="min-w-0 flex-1 break-words">{step.name}</span>
                      {here ? (
                        <span className="shrink-0 rounded-full bg-destructive/12 px-1.5 text-[10px] font-medium text-destructive">
                          Failed here
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
              <p className="flex items-center gap-1.5 px-2 pt-0.5 text-[11px] text-muted-foreground">
                <RotateCw className="h-2.5 w-2.5" />
                {count === 1 ? 'Its one step runs again' : `All ${count} steps run again`}
              </p>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** A job named in passing, for the ones that may run again or keep their result. */
function PlainRow({ job }: { job: GithubRunJob }): React.JSX.Element {
  const tone = runTone(job);
  return (
    <li className="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-xs text-muted-foreground">
      <StepGlyph tone={tone} />
      <span className="min-w-0 flex-1 break-words">{job.name}</span>
      <span className="shrink-0 text-[11px]">{tone.label}</span>
    </li>
  );
}

function LoadingJobs(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading jobs" className="space-y-1.5">
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-10 rounded-xl" />
      ))}
    </div>
  );
}

/**
 * Asks before a finished run starts again, and shows what that means: the jobs that run again,
 * each opening onto its steps with the one that broke marked, then the skipped jobs that may run
 * too and the ones that keep their result. GitHub re-runs whole jobs, never single steps.
 *
 * The jobs come from the same query the run's details read, so they are usually there already.
 * When they are not, or cannot be read, it says in words what will happen and can still confirm.
 */
export function RerunConfirmDialog({
  open,
  onOpenChange,
  scope,
  repo,
  workflowName,
  run,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: RerunScope;
  repo: string;
  workflowName: string;
  run: RerunRun;
  onConfirm: () => void;
}): React.JSX.Element {
  const copy = RERUN_SCOPES[scope];
  const details = useRunDetails(repo, run, open);
  const plan = details.data ? planRerun(details.data, scope) : null;
  const listed = plan !== null && plan.rerun.length > 0;
  const [chosen, setChosen] = useState<Record<number, boolean>>({});
  const [showKept, setShowKept] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const facts = [
    `Run #${run.runNumber}`,
    run.headBranch,
    run.headSha ? run.headSha.slice(0, 7) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          confirmRef.current?.focus();
        }}
      >
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <RotateCw className="h-4 w-4" />
          </div>
          <DialogHeader className="min-w-0 pr-6 pt-1">
            <DialogTitle className="break-words leading-snug">
              {copy.label} of {workflowName}?
            </DialogTitle>
            <p className="text-xs tabular-nums text-muted-foreground/80">{facts}</p>
            <DialogDescription>
              {listed
                ? 'These start again on the same commit. GitHub re-runs whole jobs, so every step in them runs again.'
                : details.isPending
                  ? 'GitHub re-runs whole jobs on the same commit, so every step in them runs again.'
                  : copy.explain(run.runNumber)}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="-mx-1 min-h-0 space-y-4 overflow-y-auto px-1">
          {details.isPending ? <LoadingJobs /> : null}
          {listed ? (
            <section className="space-y-2">
              <SectionHeading title="Runs again" count={plan.rerun.length} />
              <ul aria-label="Jobs that run again" className="space-y-1.5">
                {plan.rerun.map((entry) => {
                  const startsOpen =
                    plan.rerun.length === 1 || runTone(entry.job).outcome === 'failed';
                  const isOpen = chosen[entry.job.id] ?? startsOpen;
                  return (
                    <JobRow
                      key={entry.job.id}
                      entry={entry}
                      open={isOpen}
                      onToggle={() =>
                        setChosen((current) => ({ ...current, [entry.job.id]: !isOpen }))
                      }
                    />
                  );
                })}
              </ul>
            </section>
          ) : null}
          {listed && plan.maybe.length > 0 ? (
            <section className="space-y-1.5">
              <SectionHeading
                title="May run again"
                count={plan.maybe.length}
                hint="Skipped last time. GitHub runs these again if they need a job above."
              />
              <ul
                aria-label="Jobs that may run again"
                className="rounded-xl bg-foreground/[0.02] py-0.5 ring-1 ring-inset ring-foreground/[0.06]"
              >
                {plan.maybe.map(({ job }) => (
                  <PlainRow key={job.id} job={job} />
                ))}
              </ul>
            </section>
          ) : null}
          {listed && plan.kept.length > 0 ? (
            <section className="space-y-1.5">
              <button
                type="button"
                aria-expanded={showKept}
                onClick={() => setShowKept((current) => !current)}
                className="flex cursor-pointer items-center gap-1.5 rounded-md px-0.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <ChevronRight
                  className={cn(
                    'h-2.5 w-2.5 transition-transform duration-150 motion-reduce:transition-none',
                    showKept && 'rotate-90',
                  )}
                />
                {plan.kept.length === 1
                  ? '1 job keeps its result'
                  : `${plan.kept.length} jobs keep their results`}
              </button>
              {showKept ? (
                <ul aria-label="Jobs that keep their result" className="py-0.5">
                  {plan.kept.map(({ job }) => (
                    <PlainRow key={job.id} job={job} />
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
          {scope === 'all' ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{DEPLOY_WARNING}</span>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button ref={confirmRef} onClick={onConfirm}>
            <RotateCw />
            {listed ? `Re-run ${jobs(plan.rerun.length)}` : copy.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
