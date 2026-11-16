import type {
  RunnerCleanupFrequency,
  RunnerCleanupRules,
  RunnerCleanupSchedule,
  RunnerCleanupScheduleState,
  RunnerMachineLink,
} from '@shared/apiTypes';
import { DEFAULT_RUNNER_CLEANUP_SCHEDULE } from '@shared/runnerCleanup';
import { useId, useRef, useState } from 'react';
import { CalendarDays, CircleCheck, Spinner, Trash2 } from '@/components/icons';
import { Notice } from '@/components/pageKit/Notice';
import { PillTabs } from '@/components/pageKit/PillTabs';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { formatBytes } from '@/lib/format';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { describeSchedule, jobLabel, WEEKDAYS } from './cleanupView';

type AgeRule = 'logsOlderThanDays' | 'checkoutsOlderThanDays' | 'dockerOlderThanHours';
type FlagRule = 'temp' | 'actions' | 'oldVersions' | 'toolKeepNewest' | 'packageCaches';

const FLAG_RULES: { key: FlagRule; label: string; detail: string }[] = [
  { key: 'temp', label: 'Temporary files', detail: 'What jobs left in _work/_temp.' },
  {
    key: 'oldVersions',
    label: 'Old runner versions',
    detail: 'bin and externals folders a self-update left behind.',
  },
  {
    key: 'toolKeepNewest',
    label: 'Older tool versions',
    detail: 'Keeps the newest version of each tool in the tool cache.',
  },
  {
    key: 'actions',
    label: 'Downloaded actions',
    detail: 'Jobs download the ones they need again.',
  },
];

const AGE_RULES: { key: AgeRule; label: string; unit: string; max: number; detail: string }[] = [
  {
    key: 'logsOlderThanDays',
    label: 'Runner logs older than',
    unit: 'days',
    max: 365,
    detail: 'Diagnostic logs in _diag.',
  },
  {
    key: 'checkoutsOlderThanDays',
    label: 'Job checkouts unused for',
    unit: 'days',
    max: 365,
    detail: 'Working copies of repos no job has touched in that time.',
  },
  {
    key: 'dockerOlderThanHours',
    label: 'Docker leftovers older than',
    unit: 'hours',
    max: 8760,
    detail: 'Stopped containers, dangling images and build cache. Never volumes.',
  },
];

const FREQUENCIES: { value: RunnerCleanupFrequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

function removesSomething(rules: RunnerCleanupRules): boolean {
  return Object.values(rules).some((value) => value === true || typeof value === 'number');
}

function RuleBox({
  id,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <Checkbox
      id={id}
      aria-describedby={`${id}-detail`}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(value) => onChange(value === true)}
      className="mt-0.5"
    />
  );
}

/**
 * The scheduled cleanup on a runner machine (E104): a cron job on Linux, a launchd agent on macOS
 * or a Task Scheduler task on Windows, which keeps cleaning up when Runova is closed.
 */
export function CleanupScheduleForm({
  link,
  machineName,
  state,
  onSaved,
}: {
  link: RunnerMachineLink;
  machineName: string;
  state: RunnerCleanupScheduleState;
  onSaved: (state: RunnerCleanupScheduleState) => void;
}): React.JSX.Element {
  const baseId = useId();
  const [draft, setDraft] = useState<RunnerCleanupSchedule>(
    state.schedule ?? DEFAULT_RUNNER_CLEANUP_SCHEDULE,
  );
  /** The number an age rule had before it was turned off, so turning it on brings it back. */
  const remembered = useRef<Record<AgeRule, number>>({
    logsOlderThanDays: draft.rules.logsOlderThanDays ?? 14,
    checkoutsOlderThanDays: draft.rules.checkoutsOlderThanDays ?? 7,
    dockerOlderThanHours: draft.rules.dockerOlderThanHours ?? 72,
  });
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const blocked = Boolean(state.unavailable);
  const locked = blocked || busy !== null;
  const empty = !removesSomething(draft.rules);
  const job = jobLabel(state.job, machineName);

  function setRules(change: Partial<RunnerCleanupRules>): void {
    setDraft((current) => ({ ...current, rules: { ...current.rules, ...change } }));
  }

  function setAge(key: AgeRule, raw: string): void {
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) return;
    remembered.current[key] = value;
    setRules({ [key]: value });
  }

  async function run(kind: 'save' | 'remove'): Promise<void> {
    setBusy(kind);
    setNote(null);
    setError(null);
    try {
      const result =
        kind === 'save'
          ? await window.runova.runnerCleanup.saveSchedule(link, draft)
          : await window.runova.runnerCleanup.removeSchedule(link);
      if (result.ok) {
        onSaved(result.state);
        setNote(result.note ?? null);
      } else {
        setError(result.error);
      }
    } catch (failure) {
      setError(ipcErrorMessage(failure, 'The machine did not answer.'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!locked && !empty) void run('save');
      }}
    >
      <div
        className={cn(
          'flex items-start gap-3 rounded-xl px-3.5 py-3 ring-1 ring-inset',
          state.installed
            ? 'bg-success/[0.06] ring-success/25'
            : 'bg-foreground/[0.025] ring-foreground/[0.08]',
        )}
      >
        <span
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
            state.installed ? 'bg-success/15 text-success' : 'bg-primary/12 text-primary',
          )}
        >
          {state.installed ? (
            <CircleCheck className="h-3.5 w-3.5" />
          ) : (
            <CalendarDays className="h-3.5 w-3.5" />
          )}
        </span>
        <div className="flex min-w-0 flex-col gap-0.5 text-xs">
          {state.installed && state.schedule ? (
            <>
              <span className="text-[13px] font-semibold">{describeSchedule(state.schedule)}</span>
              <span className="text-muted-foreground">{`Runs as ${job}, also while Runova is closed.`}</span>
            </>
          ) : (
            <>
              <span className="text-[13px] font-semibold">No scheduled cleanup yet</span>
              <span className="text-muted-foreground">
                {`Runova can leave ${job} that frees space on its own, also while Runova is closed.`}
              </span>
            </>
          )}
          {state.lastRun ? (
            <span className={cn(state.lastRun.ok ? 'text-muted-foreground' : 'text-warning')}>
              {`Last ran ${timeAgo(state.lastRun.at)} and freed ${formatBytes(state.lastRun.freedBytes)}${state.lastRun.ok ? '' : ', but some things could not be removed'}.`}
            </span>
          ) : null}
        </div>
      </div>

      {state.unavailable ? (
        <Notice tone="warning" size="sm">
          {state.unavailable}
        </Notice>
      ) : null}

      <fieldset disabled={locked} className="flex flex-col gap-2.5">
        <legend className="mb-2 text-xs font-medium text-foreground">When it runs</legend>
        <div className="flex flex-wrap items-center gap-2">
          <PillTabs
            id={`${baseId}-frequency`}
            label="How often"
            kind="toggle"
            items={FREQUENCIES}
            value={draft.frequency}
            onChange={(frequency) => setDraft((current) => ({ ...current, frequency }))}
          />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            at
            <Input
              type="time"
              aria-label="Time"
              value={draft.time}
              required
              onChange={(event) =>
                setDraft((current) => ({ ...current, time: event.target.value }))
              }
              className="h-7 w-[6.5rem] text-xs tabular-nums"
            />
          </label>
        </div>
        {draft.frequency === 'weekly' ? (
          <PillTabs
            id={`${baseId}-weekday`}
            label="Day of the week"
            kind="toggle"
            size="xs"
            items={WEEKDAYS.map((day, index) => ({ value: String(index), label: day.slice(0, 3) }))}
            value={String(draft.weekday)}
            onChange={(day) => setDraft((current) => ({ ...current, weekday: Number(day) }))}
          />
        ) : null}
        {draft.frequency === 'monthly' ? (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            On day
            <Input
              type="number"
              aria-label="Day of the month"
              min={1}
              max={28}
              value={draft.dayOfMonth}
              onChange={(event) => {
                const day = Number.parseInt(event.target.value, 10);
                if (day >= 1 && day <= 28) setDraft((current) => ({ ...current, dayOfMonth: day }));
              }}
              className="h-7 w-16 text-xs tabular-nums"
            />
            of every month
          </label>
        ) : null}
        <p className="text-[11px] text-muted-foreground">
          {`Times are in ${machineName}'s own clock. ${
            state.job === 'cron'
              ? 'Cron skips a run while the machine is off.'
              : 'A run the machine slept through happens when it wakes up.'
          }`}
        </p>
      </fieldset>

      <fieldset disabled={locked} className="flex flex-col gap-1">
        <legend className="mb-2 text-xs font-medium text-foreground">What it removes</legend>
        {FLAG_RULES.map((rule) => {
          const id = `${baseId}-${rule.key}`;
          return (
            <div key={rule.key} className="flex items-start gap-2.5 rounded-lg px-1 py-1">
              <RuleBox
                id={id}
                checked={draft.rules[rule.key]}
                disabled={locked}
                onChange={(checked) => setRules({ [rule.key]: checked })}
              />
              <div className="flex flex-col">
                <label htmlFor={id} className="cursor-pointer text-[13px] font-medium">
                  {rule.label}
                </label>
                <span id={`${id}-detail`} className="text-[11px] text-muted-foreground">
                  {rule.detail}
                </span>
              </div>
            </div>
          );
        })}
        {AGE_RULES.map((rule) => {
          const id = `${baseId}-${rule.key}`;
          const value = draft.rules[rule.key];
          return (
            <div key={rule.key} className="flex items-start gap-2.5 rounded-lg px-1 py-1">
              <RuleBox
                id={id}
                checked={value !== null}
                disabled={locked}
                onChange={(checked) =>
                  setRules({ [rule.key]: checked ? remembered.current[rule.key] : null })
                }
              />
              <div className="flex flex-col">
                <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
                  <label htmlFor={id} className="cursor-pointer">
                    {rule.label}
                  </label>
                  <Input
                    type="number"
                    aria-label={`${rule.label}, in ${rule.unit}`}
                    min={1}
                    max={rule.max}
                    disabled={locked || value === null}
                    value={value ?? remembered.current[rule.key]}
                    onChange={(event) => setAge(rule.key, event.target.value)}
                    className="h-6 w-16 text-xs tabular-nums"
                  />
                  <span className="font-normal text-muted-foreground">{rule.unit}</span>
                </span>
                <span id={`${id}-detail`} className="text-[11px] text-muted-foreground">
                  {rule.detail}
                </span>
              </div>
            </div>
          );
        })}
        <div className="flex items-start gap-2.5 rounded-lg px-1 py-1">
          <RuleBox
            id={`${baseId}-packageCaches`}
            checked={draft.rules.packageCaches}
            disabled={locked}
            onChange={(checked) => setRules({ packageCaches: checked })}
          />
          <div className="flex flex-col">
            <label
              htmlFor={`${baseId}-packageCaches`}
              className="cursor-pointer text-[13px] font-medium"
            >
              Package caches
            </label>
            <span
              id={`${baseId}-packageCaches-detail`}
              className="text-[11px] text-muted-foreground"
            >
              npm, pnpm, Yarn, pip, Gradle, Maven, NuGet, Go and Cargo, for the account the job runs
              as.
            </span>
          </div>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          A runner in the middle of a job is skipped until the next run. The job never removes a
          whole runner.
        </p>
      </fieldset>

      {empty ? (
        <p className="text-xs text-warning">Pick at least one thing for the job to remove.</p>
      ) : null}
      {note ? (
        <Notice tone="primary" size="sm">
          {note}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="destructive" size="sm">
          {error}
        </Notice>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        {state.installed ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={locked}
            onClick={() => void run('remove')}
            className="mr-auto text-muted-foreground hover:text-destructive"
          >
            {busy === 'remove' ? (
              <Spinner className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Remove job
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={locked || empty}>
          {busy === 'save' ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : null}
          Save job
        </Button>
      </div>
    </form>
  );
}
