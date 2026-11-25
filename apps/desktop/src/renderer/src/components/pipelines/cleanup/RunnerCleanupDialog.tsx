import type { RunnerCleanupDisk, RunnerCleanupScan, RunnerMachineLink } from '@shared/apiTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Broom, CircleCheck, Lock, RefreshCw, Spinner } from '@/components/icons';
import { Notice } from '@/components/pageKit/Notice';
import { PillTabs } from '@/components/pageKit/PillTabs';
import { SshVaultUnlockDialog } from '@/components/remote/SshVaultUnlockDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import {
  type MachineCleanup,
  machineKeyOf,
  machineState,
  useRunnerCleanupStore,
} from '@/stores/runnerCleanupStore';
import { CleanupItemList } from './CleanupItemList';
import { CleanupLoading } from './CleanupLoading';
import { CleanupScheduleForm } from './CleanupScheduleForm';
import {
  cleanupConfirm,
  defaultPicks,
  diskPercents,
  selectionBytes,
  totalBytes,
} from './cleanupView';

/** A scan older than this is read again when the dialog opens, since jobs keep writing. */
const STALE_MS = 5 * 60_000;

type Tab = 'clean' | 'schedule';

function DiskBar({
  disk,
  freeing,
}: {
  disk: RunnerCleanupDisk;
  freeing: number;
}): React.JSX.Element | null {
  const percents = diskPercents(disk, freeing);
  if (!percents) return null;
  const tone =
    percents.now >= 95 ? 'bg-destructive' : percents.now >= 80 ? 'bg-warning' : 'bg-primary/70';
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-foreground/[0.025] px-3.5 py-3 ring-1 ring-inset ring-foreground/[0.08]">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          {`${formatBytes(disk.usedBytes)} of ${formatBytes(disk.totalBytes)} used on ${disk.mount}`}
        </span>
        {freeing > 0 ? (
          <span className="font-medium tabular-nums text-success">{`${percents.after}% after cleanup`}</span>
        ) : (
          <span className="font-medium tabular-nums">{`${percents.now}%`}</span>
        )}
      </div>
      <div
        role="img"
        aria-label={`Disk ${percents.now}% used, ${percents.after}% after cleanup`}
        className="relative h-2 overflow-hidden rounded-full bg-foreground/[0.08]"
      >
        <span
          className={cn(
            'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500',
            tone,
          )}
          style={{ width: `${percents.now}%` }}
        />
        {freeing > 0 ? (
          <span
            className="absolute inset-y-0 bg-success/80 transition-[left,width] duration-500 [background-image:repeating-linear-gradient(135deg,transparent_0_3px,hsl(var(--background)/0.35)_3px_6px)]"
            style={{ left: `${percents.after}%`, width: `${percents.now - percents.after}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}

function Problem({
  state,
  link,
  machineName,
  onRetry,
}: {
  state: MachineCleanup;
  link: RunnerMachineLink;
  machineName: string;
  onRetry: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [unlockOpen, setUnlockOpen] = useState(false);
  const error = state.error;
  if (error?.reason === 'locked') {
    return (
      <>
        <Notice tone="warning">
          <div className="flex flex-col gap-2">
            <span className="font-medium">The Servers vault is locked</span>
            <span className="text-muted-foreground">
              {`Unlock it so Runova can sign in to ${machineName}.`}
            </span>
            <Button
              size="sm"
              variant="soft"
              className="self-start"
              onClick={() => setUnlockOpen(true)}
            >
              <Lock className="h-3.5 w-3.5" />
              Unlock
            </Button>
          </div>
        </Notice>
        <SshVaultUnlockDialog
          open={unlockOpen}
          onOpenChange={setUnlockOpen}
          mode="unlock"
          onUnlocked={() => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.sshVaultStatus });
            onRetry();
          }}
        />
      </>
    );
  }
  const title =
    error?.reason === 'missing'
      ? 'The linked server was removed'
      : error?.reason === 'unsupported'
        ? `${machineName} answered in a way Runova does not understand`
        : error?.reason === 'off'
          ? 'Not available in a test run'
          : `Could not reach ${link.kind === 'local' ? 'this computer' : machineName}`;
  return (
    <Notice tone="destructive">
      <div className="flex flex-col gap-2">
        <span className="font-medium">{title}</span>
        {error?.message ? <span className="text-muted-foreground">{error.message}</span> : null}
        {error?.reason !== 'missing' && error?.reason !== 'off' ? (
          <Button size="sm" variant="soft" className="self-start" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5" />
            Try again
          </Button>
        ) : null}
      </div>
    </Notice>
  );
}

function Findings({
  scan,
  state,
  picks,
  machineName,
  onPicksChange,
}: {
  scan: RunnerCleanupScan;
  state: MachineCleanup;
  picks: Set<string>;
  machineName: string;
  onPicksChange: (picks: Set<string>) => void;
}): React.JSX.Element {
  const cleaning = state.phase === 'cleaning';
  const done = state.phase === 'done';
  const total = totalBytes(scan);
  const failed = Object.values(state.outcomes).filter(
    (outcome) => outcome.status === 'failed',
  ).length;
  const allIds = new Set(
    scan.groups.flatMap((group) =>
      group.items.filter((item) => !item.disabledReason).map((item) => item.id),
    ),
  );
  return (
    <div className="flex flex-col gap-3">
      {scan.disk ? (
        <DiskBar disk={scan.disk} freeing={done ? 0 : selectionBytes(scan, picks)} />
      ) : null}
      {done ? (
        <Notice tone={failed > 0 ? 'warning' : 'success'}>
          {`Freed ${formatBytes(state.freedBytes)} on ${machineName}.${failed > 0 ? ` ${failed} ${failed === 1 ? 'item' : 'items'} could not be removed; the reason is under each.` : ''}`}
        </Notice>
      ) : null}
      {state.phase === 'failed' && state.error ? (
        <Notice tone="destructive">{state.error.message}</Notice>
      ) : null}
      {scan.notes.map((note) => (
        <Notice key={note} tone="neutral" size="sm">
          {note}
        </Notice>
      ))}
      {scan.groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success/12 text-success">
            <CircleCheck className="h-5 w-5" />
          </span>
          <span className="text-sm font-semibold">{`Nothing to clean up on ${machineName}`}</span>
          <span className="max-w-sm text-xs text-muted-foreground">
            No runner leftovers, Docker leftovers or package caches were found.
          </span>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 aria-live="polite" className="text-sm font-semibold">
              {done ? 'What happened' : `Up to ${formatBytes(total)} can be freed`}
            </h3>
            {done ? null : (
              <div role="group" aria-label="Pick" className="flex items-center gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={cleaning}
                  onClick={() => onPicksChange(defaultPicks(scan))}
                >
                  Recommended
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={cleaning}
                  onClick={() => onPicksChange(allIds)}
                >
                  All
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={cleaning}
                  onClick={() => onPicksChange(new Set())}
                >
                  None
                </Button>
              </div>
            )}
          </div>
          <CleanupItemList
            groups={scan.groups}
            picks={picks}
            onPicksChange={onPicksChange}
            outcomes={state.outcomes}
            running={new Set(state.running)}
            locked={cleaning || done}
          />
        </>
      )}
    </div>
  );
}

/**
 * Frees disk space on a self-hosted runner's machine (E104): what earlier jobs left behind, old
 * runner versions, runners GitHub no longer has, Docker leftovers and package caches, and a job
 * on the machine that keeps doing it.
 */
export function RunnerCleanupDialog({
  open,
  onOpenChange,
  link,
  machineName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  link: RunnerMachineLink;
  machineName: string;
}): React.JSX.Element {
  const tabsId = useId();
  const machine = machineKeyOf(link);
  const state = useRunnerCleanupStore((store) => machineState(store, machine));
  const startScan = useRunnerCleanupStore((store) => store.scan);
  const cancelScan = useRunnerCleanupStore((store) => store.cancelScan);
  const setPicks = useRunnerCleanupStore((store) => store.setPicks);
  const clean = useRunnerCleanupStore((store) => store.clean);
  const setScheduleState = useRunnerCleanupStore((store) => store.setScheduleState);
  const [tab, setTab] = useState<Tab>('clean');
  const primaryRef = useRef<HTMLButtonElement>(null);

  const { phase, scan } = state;
  const picks = useMemo(() => new Set(state.picks), [state.picks]);
  const scanning = phase === 'scanning';
  const cleaning = phase === 'cleaning';
  const bytes = scan ? selectionBytes(scan, picks) : 0;

  // Opening is the request to look, so a machine not scanned lately is scanned straight away.
  useEffect(() => {
    if (!open) return;
    const { phase: now, scan: held } = machineState(useRunnerCleanupStore.getState(), machine);
    const stale = !held || Date.now() - held.scannedAt > STALE_MS;
    if (now === 'idle' || (now === 'ready' && stale)) void startScan(link);
  }, [open, machine, link, startScan]);

  useEffect(() => {
    if (phase === 'ready' && tab === 'clean') primaryRef.current?.focus();
  }, [phase, tab]);

  async function cleanPicked(): Promise<void> {
    if (!scan || picks.size === 0) return;
    const confirm = cleanupConfirm(scan, picks, machineName);
    const yes = await confirmDialog({
      title: confirm.title,
      description: confirm.description,
      items: confirm.items,
      warning: confirm.warning,
      confirmLabel: confirm.confirmLabel,
      variant: 'destructive',
      icon: Broom,
    });
    if (yes) await clean(link, machineName);
  }

  let body: React.ReactNode;
  if (tab === 'schedule') {
    body = scan ? (
      <CleanupScheduleForm
        key={`${scan.scanId}-${scan.schedule.installed}`}
        link={link}
        machineName={machineName}
        state={scan.schedule}
        onSaved={(next) => setScheduleState(machine, next)}
      />
    ) : scanning ? (
      <CleanupLoading tab="schedule" seen={state.steps} machineName={machineName} />
    ) : (
      <Problem
        state={state}
        link={link}
        machineName={machineName}
        onRetry={() => void startScan(link)}
      />
    );
  } else if (scanning) {
    body = <CleanupLoading tab="clean" seen={state.steps} machineName={machineName} />;
  } else if (scan) {
    body = (
      <Findings
        scan={scan}
        state={state}
        picks={picks}
        machineName={machineName}
        onPicksChange={(next) => setPicks(machine, [...next])}
      />
    );
  } else if (phase === 'failed') {
    body = (
      <Problem
        state={state}
        link={link}
        machineName={machineName}
        onRetry={() => void startScan(link)}
      />
    );
  } else {
    body = <CleanupLoading tab="clean" seen={[]} machineName={machineName} />;
  }

  const showFooter = tab === 'clean' && (scanning || scan !== null);
  const needsRescan = phase === 'done' || (phase === 'failed' && scan !== null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 p-0">
        <DialogHeader className="gap-3 px-6 pb-4 pt-6">
          <DialogTitle className="flex items-center gap-2">
            <Broom className="h-4 w-4 text-primary" />
            {`Clean up ${machineName}`}
          </DialogTitle>
          <DialogDescription>
            Free the space earlier jobs, old runner versions and caches take on this machine, now or
            on a schedule.
          </DialogDescription>
          <PillTabs
            id={tabsId}
            label="Runner cleanup"
            items={[
              { value: 'clean', label: 'Clean now' },
              { value: 'schedule', label: 'Schedule' },
            ]}
            value={tab}
            onChange={setTab}
            className="self-start"
          />
        </DialogHeader>
        <div className="rail-scroll min-h-0 overflow-y-auto px-6 pb-5">{body}</div>
        {showFooter ? (
          <DialogFooter className="items-center gap-2 border-t border-foreground/[0.06] px-6 py-3 sm:justify-between">
            <span aria-live="polite" className="text-xs text-muted-foreground tabular-nums">
              {scan && !needsRescan && picks.size > 0
                ? `${picks.size} picked, ${formatBytes(bytes)}`
                : ''}
            </span>
            <div className="flex items-center gap-2">
              {scanning ? (
                <Button variant="ghost" size="sm" onClick={() => void cancelScan(link)}>
                  Stop
                </Button>
              ) : needsRescan ? (
                <Button ref={primaryRef} size="sm" onClick={() => void startScan(link)}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  Scan again
                </Button>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={cleaning}
                    onClick={() => void startScan(link)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Scan again
                  </Button>
                  <Button
                    ref={primaryRef}
                    size="sm"
                    disabled={cleaning || picks.size === 0}
                    onClick={() => void cleanPicked()}
                  >
                    {cleaning ? (
                      <Spinner className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Broom className="h-3.5 w-3.5" />
                    )}
                    {cleaning
                      ? 'Cleaning…'
                      : picks.size === 0
                        ? 'Clean up'
                        : `Clean up ${formatBytes(bytes)}`}
                  </Button>
                </>
              )}
            </div>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
