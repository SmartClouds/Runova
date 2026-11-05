import type { Project } from '@runova/core';
import type { CleanupRemoveEvent, ProjectCleanupScan } from '@shared/projectCleanupTypes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { HardDrive, Lock, RefreshCw, Trash2 } from '@/components/icons';
import { EmptyState, Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/format';
import {
  applyScanEvent,
  EMPTY_LIVE_SCAN,
  type LiveScan,
  liveToScan,
} from '@/lib/projectCleanup/liveScan';
import { isCancelled, runRemove, runScan } from '@/lib/projectCleanup/runCleanup';
import {
  composition,
  defaultSelection,
  groupRows,
  presetSelection,
  reclaimableBytes,
  restoreCommands,
  rowsFromScan,
  type SelectionPreset,
  selectionTotals,
  summarize,
  toggleGroup,
  toRemoveItems,
  withoutRemoved,
} from '@/lib/projectCleanup/selection';
import { confirmDialog } from '@/stores/confirmStore';
import { useProjectCleanupStore } from '@/stores/projectCleanupStore';
import { ipcErrorMessage } from '../environments/ipcError';
import { CleanupActionBar } from './CleanupActionBar';
import { CleanupGroupList, type RowStatus } from './CleanupGroupList';
import { CleanupHero } from './CleanupHero';

/**
 * A project's Cleanup tab. It scans when it opens (unless it already has a result from this
 * session), shows what the project weighs and which folders it could rebuild, and deletes the
 * ones the person picks after one clear confirm.
 *
 * What it offers is decided in the main process and checked there again before anything is
 * deleted. This only picks from what a scan reported.
 */

type Phase = 'scanning' | 'ready' | 'stopped' | 'error';

/** How many folders the confirm lists by name before it says "and 3 more". */
const CONFIRM_LISTED = 6;

const PRESETS: { id: SelectionPreset; label: string }[] = [
  { id: 'safe', label: 'Safe pick' },
  { id: 'all', label: 'Select all' },
  { id: 'none', label: 'Select none' },
];

function statusFromEvent(event: CleanupRemoveEvent): RowStatus {
  if (event.status === 'removing') return { status: 'removing' };
  if (event.status === 'done') return { status: 'done', freedBytes: event.freedBytes ?? 0 };
  return { status: 'failed', error: event.error ?? 'Could not delete it.' };
}

export function ProjectCleanupTab({ project }: { project: Project }): React.JSX.Element {
  const projectId = project.id;
  const stored = useProjectCleanupStore((state) => state.scans[projectId]);
  const recordScan = useProjectCleanupStore((state) => state.recordScan);

  const [phase, setPhase] = useState<Phase>(stored ? 'ready' : 'scanning');
  const [live, setLive] = useState<LiveScan>(EMPTY_LIVE_SCAN);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() =>
    stored ? defaultSelection(rowsFromScan(stored)) : new Set(),
  );
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({});
  const [removing, setRemoving] = useState<{ done: number; total: number } | null>(null);
  const running = useRef<AbortController | null>(null);

  const startScan = useCallback(async (): Promise<void> => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setPhase('scanning');
    setError(null);
    setLive(EMPTY_LIVE_SCAN);
    setStatuses({});
    try {
      const result = await runScan(projectId, {
        signal: controller.signal,
        onEvent: (event) => setLive((previous) => applyScanEvent(previous, event)),
      });
      if (running.current !== controller) return;
      recordScan(projectId, result);
      setSelected(defaultSelection(rowsFromScan(result)));
      setPhase('ready');
    } catch (caught) {
      // A newer scan took over, or the tab closed: whatever this one says no longer matters.
      if (running.current !== controller) return;
      if (isCancelled(caught)) {
        setPhase(useProjectCleanupStore.getState().scans[projectId] ? 'ready' : 'stopped');
        return;
      }
      setError(ipcErrorMessage(caught, 'The scan could not finish.'));
      setPhase('error');
    }
  }, [projectId, recordScan]);

  // Starts on the next tick, so React's double mount in development cancels the first start
  // instead of racing a second scan against it.
  useEffect(() => {
    if (useProjectCleanupStore.getState().scans[projectId]) return;
    const timer = setTimeout(() => void startScan(), 0);
    return () => {
      clearTimeout(timer);
      running.current?.abort();
      running.current = null;
    };
  }, [projectId, startScan]);

  const scanning = phase === 'scanning';
  const scan: ProjectCleanupScan | null = useMemo(
    () => (scanning ? liveToScan(projectId, live, Date.now()) : (stored ?? null)),
    [scanning, projectId, live, stored],
  );
  const rows = useMemo(() => (scan ? rowsFromScan(scan) : []), [scan]);
  const groups = useMemo(() => groupRows(rows, selected), [rows, selected]);
  const totals = useMemo(() => selectionTotals(rows, selected), [rows, selected]);
  const busy = scanning || removing !== null;

  const toggleRow = (key: string): void =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  async function removeKeys(keys: string[]): Promise<void> {
    const items = toRemoveItems(rows, new Set(keys));
    if (items.length === 0) return;
    setRemoving({ done: 0, total: items.length });
    try {
      const result = await runRemove(projectId, items, {
        onEvent: (event) => {
          setStatuses((previous) => ({ ...previous, [event.key]: statusFromEvent(event) }));
          if (event.status !== 'removing') {
            setRemoving((previous) =>
              previous
                ? { ...previous, done: Math.min(previous.total, previous.done + 1) }
                : previous,
            );
          }
        },
      });
      const gone = new Set(result.removed);
      const latest = useProjectCleanupStore.getState().scans[projectId];
      if (latest) recordScan(projectId, withoutRemoved(latest, gone));
      setSelected((previous) => new Set([...previous].filter((key) => !gone.has(key))));
      setStatuses(
        Object.fromEntries(
          result.failed.map((failure) => [
            failure.key,
            { status: 'failed', error: failure.error } satisfies RowStatus,
          ]),
        ),
      );
      if (result.removed.length > 0) {
        toast.success(`Freed about ${formatBytes(result.freedBytes)}.`);
      } else if (result.failed.length > 0) {
        toast.error('Nothing could be deleted. The reasons are in the list.');
      }
    } catch (caught) {
      setStatuses({});
      toast.error(ipcErrorMessage(caught, 'Could not delete.'));
    } finally {
      setRemoving(null);
    }
  }

  async function deleteSelected(): Promise<void> {
    const picked = rows.filter((row) => !row.locked && selected.has(row.key));
    if (picked.length === 0) return;
    const commands = restoreCommands(rows, selected);
    const confirmed = await confirmDialog({
      title: picked.length === 1 ? `Delete ${picked[0]?.name}?` : `Delete ${picked.length} items?`,
      description: `This frees about ${formatBytes(totals.freeBytes)}. They are deleted for good, not moved to the Recycle Bin, and only folders the project can rebuild are ever deleted.`,
      items: [...picked]
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, CONFIRM_LISTED)
        .map((row) => ({
          name: row.name,
          detail: `${row.group === 'studio' ? 'Render cache' : row.detail}, ${formatBytes(row.bytes)}`,
          isDirectory: row.group !== 'studio',
        })),
      moreCount: Math.max(0, picked.length - CONFIRM_LISTED),
      warning:
        commands.length > 0
          ? `To get the dependencies back, run ${commands.join(' and ')} in the project.`
          : 'Nothing here is your own work. It is made again the next time it is needed.',
      icon: Trash2,
      variant: 'destructive',
      confirmLabel: `Delete ${formatBytes(totals.freeBytes)}`,
    });
    if (!confirmed) return;
    await removeKeys(picked.map((row) => row.key));
  }

  if (phase === 'error') {
    return (
      <Notice
        tone="destructive"
        action={
          <Button size="sm" variant="soft" onClick={() => void startScan()}>
            <RefreshCw className="h-3.5 w-3.5" />
            Try again
          </Button>
        }
      >
        {error}
      </Notice>
    );
  }

  if (phase === 'stopped') {
    return (
      <EmptyState
        card
        icon={HardDrive}
        title="Scan stopped"
        description="Run it again to see what this project takes up and what it can rebuild."
        action={
          <Button size="sm" onClick={() => void startScan()}>
            Scan project
          </Button>
        }
      />
    );
  }

  const heroScan = scan ?? { projectId, scannedAt: 0, locations: [], studio: [] };
  const summary = summarize(heroScan);

  return (
    <div className="space-y-4">
      <CleanupHero
        phase={scanning ? 'scanning' : 'ready'}
        freeBytes={reclaimableBytes(heroScan)}
        totalBytes={summary.totalBytes}
        parts={scanning ? [] : composition(heroScan)}
        scannedAt={scanning ? null : heroScan.scannedAt}
        filesSeen={live.files}
        lookingIn={live.lookingIn}
        onScan={() => void startScan()}
        onCancel={() => running.current?.abort()}
      />

      {!scanning && rows.some((row) => !row.locked) && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <p className="text-sm text-muted-foreground">Pick what to delete.</p>
          <div className="flex items-center gap-1">
            {PRESETS.map((preset) => (
              <Button
                key={preset.id}
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => setSelected(presetSelection(rows, preset.id))}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {groups.length > 0 && (
        <CleanupGroupList
          groups={groups}
          selected={selected}
          statuses={statuses}
          disabled={busy}
          onToggleRow={toggleRow}
          onToggleGroup={(group) => setSelected((previous) => toggleGroup(group.rows, previous))}
          onRetry={(key) => void removeKeys([key])}
        />
      )}

      {!scanning && (
        <p className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
          <Lock className="mt-px h-3 w-3 shrink-0" />
          <span>
            Cleanup never touches your source, your .env files or your git history, and Studio keeps
            your videos, recordings and generated media. It only deletes folders the project can
            rebuild.
          </span>
        </p>
      )}

      <CleanupActionBar
        count={totals.count}
        freeBytes={totals.freeBytes}
        removing={removing !== null}
        progress={removing}
        onDelete={() => void deleteSelected()}
        onClear={() => setSelected(new Set())}
      />
    </div>
  );
}
