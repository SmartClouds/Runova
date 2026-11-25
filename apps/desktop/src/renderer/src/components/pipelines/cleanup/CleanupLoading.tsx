import { Broom, CalendarDays, Check } from '@/components/icons';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export const SCAN_STEPS = [
  { step: 'runners', label: 'Finding runner folders' },
  { step: 'docker', label: 'Checking Docker' },
  { step: 'caches', label: 'Measuring package caches' },
  { step: 'schedule', label: 'Reading the scheduled job' },
] as const;

/** Where a scan is: the step running now (by index) and how far along the bar should be. */
export function scanProgress(seen: readonly string[]): { current: number; percent: number } {
  const last = seen.at(-1);
  const found = SCAN_STEPS.findIndex(({ step }) => step === last);
  const current = Math.max(0, found);
  // The running step counts as half done, so the bar moves as soon as a step starts.
  return { current, percent: ((current + 0.5) / SCAN_STEPS.length) * 100 };
}

function Stepper({ current }: { current: number }): React.JSX.Element {
  return (
    <ol className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
      {SCAN_STEPS.map(({ step, label }, index) => {
        const done = index < current;
        const running = index === current;
        return (
          <li
            key={step}
            aria-current={running ? 'step' : undefined}
            className={cn(
              'flex items-center gap-1.5 text-[11px] leading-tight transition-colors duration-300',
              done || running ? 'text-foreground' : 'text-muted-foreground/70',
            )}
          >
            <span
              className={cn(
                'relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors duration-300',
                done
                  ? 'bg-success/15 text-success'
                  : running
                    ? 'bg-primary/15 text-primary'
                    : 'bg-foreground/[0.06]',
              )}
            >
              {done ? (
                <Check className="h-2 w-2 animate-in zoom-in-50 fade-in-0 duration-300" />
              ) : running ? (
                <>
                  <span className="absolute inset-0 animate-ping rounded-full bg-primary/30 motion-reduce:animate-none" />
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                </>
              ) : (
                <span className="h-1 w-1 rounded-full bg-current opacity-60" />
              )}
            </span>
            <span className={cn(running && 'font-medium')}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** The shape of the findings (disk bar, then a couple of runner cards) while they load. */
function FindingsPreview(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-xl bg-foreground/[0.025] px-3.5 py-3 ring-1 ring-inset ring-foreground/[0.08]">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-3 w-8" />
        </div>
        <Skeleton className="h-2 w-full rounded-full" />
      </div>
      {[3, 2].map((rows, group) => (
        <div
          key={group}
          className="overflow-hidden rounded-xl bg-foreground/[0.02] ring-1 ring-inset ring-foreground/[0.08]"
        >
          <div className="flex items-center gap-3 border-b border-foreground/[0.06] px-3 py-2.5">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-6 w-6 rounded-md" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className={cn('h-3', group === 0 ? 'w-28' : 'w-20')} />
              <Skeleton className="h-2.5 w-40" />
            </div>
            <Skeleton className="h-3 w-12" />
          </div>
          <div className="flex flex-col p-1">
            {Array.from({ length: rows }, (_, row) => (
              <div key={row} className="flex items-start gap-3 px-2.5 py-2">
                <Skeleton className="mt-0.5 h-4 w-4 rounded" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className={cn('h-3', ['w-32', 'w-40', 'w-24'][row])} />
                  <Skeleton className={cn('h-2.5', ['w-64', 'w-52', 'w-72'][row])} />
                </div>
                <Skeleton className="mt-0.5 h-3 w-12" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The shape of the schedule form (job status, when it runs, what it removes) while it loads. */
function SchedulePreview(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-xl bg-foreground/[0.025] px-3.5 py-3 ring-1 ring-inset ring-foreground/[0.08]">
        <Skeleton className="h-7 w-7 shrink-0 rounded-lg" />
        <div className="flex flex-1 flex-col gap-1.5 pt-0.5">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-2.5 w-72" />
        </div>
      </div>
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3 w-24" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-7 w-52 rounded-full" />
          <Skeleton className="h-7 w-24 rounded-lg" />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Skeleton className="mb-2 h-3 w-28" />
        {['w-28', 'w-36', 'w-32', 'w-40'].map((width) => (
          <div key={width} className="flex items-start gap-2.5 px-1 py-1">
            <Skeleton className="mt-0.5 h-4 w-4 rounded" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className={cn('h-3', width)} />
              <Skeleton className="h-2.5 w-56" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * What the cleanup dialog shows while it scans a machine, on either tab: where the scan is, then a
 * faded outline of what the tab will show once the machine answers.
 */
export function CleanupLoading({
  tab,
  seen,
  machineName,
}: {
  tab: 'clean' | 'schedule';
  seen: readonly string[];
  machineName: string;
}): React.JSX.Element {
  const { current, percent } = scanProgress(seen);
  const step = SCAN_STEPS[current];
  const readingSchedule = step.step === 'schedule';
  const Icon = tab === 'schedule' ? CalendarDays : Broom;

  const title =
    tab === 'schedule' && readingSchedule ? 'Reading the scheduled job' : `Scanning ${machineName}`;
  const detail =
    tab === 'schedule'
      ? readingSchedule
        ? `Looking for a cleanup job Runova left on ${machineName}.`
        : 'The scheduled job is read last, once the folders and caches are measured.'
      : 'Measuring big work folders and caches can take a minute.';

  return (
    <div className="flex flex-col gap-4 py-1 animate-in fade-in-0 duration-300">
      <div className="flex flex-col gap-3 rounded-xl bg-primary/[0.04] px-4 py-3.5 ring-1 ring-inset ring-primary/15">
        <div className="flex items-center gap-3">
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
            <span
              aria-hidden
              className="absolute -inset-[3px] animate-spin rounded-full border-2 border-transparent border-t-primary [animation-duration:1.1s] motion-reduce:animate-none"
            />
            <Icon className="h-4 w-4" />
          </span>
          <div aria-live="polite" className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[13px] font-semibold">{title}</span>
            <span className="text-xs text-muted-foreground">{detail}</span>
          </div>
          <span className="shrink-0 self-start text-[11px] font-medium tabular-nums text-muted-foreground">
            {`${current + 1} of ${SCAN_STEPS.length}`}
          </span>
        </div>
        <ProgressBar
          value={percent}
          label="Scan progress"
          valueText={`Step ${current + 1} of ${SCAN_STEPS.length}, ${step.label}`}
          marks={[25, 50, 75]}
          live
        />
        <Stepper current={current} />
      </div>
      <div
        aria-hidden
        className="pointer-events-none [mask-image:linear-gradient(to_bottom,black_35%,transparent)]"
      >
        {tab === 'schedule' ? <SchedulePreview /> : <FindingsPreview />}
      </div>
    </div>
  );
}
