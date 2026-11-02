import { diffDotenvKeys } from '@runova/core';
import type {
  EnvFileOrigin,
  EnvFileSummary,
  EnvFileVersionSummary,
  ProjectEnvironment,
} from '@shared/apiTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MonacoDiffEditor } from '@/components/editor/MonacoDiffEditor';
import { MonacoEditor } from '@/components/editor/MonacoEditor';
import { History, Spinner, Undo } from '@/components/icons';
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
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { ipcErrorMessage } from './ipcError';

export interface EnvFileHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: ProjectEnvironment;
  file: EnvFileSummary;
  /** Called after a version was put back, so the environment list can refresh. */
  onRestored: () => void;
}

const CURRENT = 'current';
const EDITOR_HEIGHT = 'h-[360px]';

const ORIGIN_LABELS: Record<EnvFileOrigin, string> = {
  created: 'Created',
  edited: 'Edited',
  imported: 'Imported from folder',
  restored: 'Restored',
  renamed: 'Renamed',
};

function originLabel(origin: EnvFileOrigin | undefined): string {
  return origin ? ORIGIN_LABELS[origin] : 'Saved';
}

function keysLabel(count: number): string {
  return `${count} ${count === 1 ? 'key' : 'keys'}`;
}

function exactTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function relativeTime(ms: number): string {
  return timeAgo(new Date(ms).toISOString());
}

/** One row of the timeline: the current file or an earlier version of it. */
interface TimelineEntry {
  id: string;
  label: string;
  fileName: string;
  keyCount: number;
  savedAt: number;
}

function KeyChips({ before, after }: { before: string; after: string }): React.JSX.Element {
  const diff = useMemo(() => diffDotenvKeys(before, after), [before, after]);
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  const chips = [
    ...diff.added.map((key) => ({
      key,
      sign: '+',
      kind: 'added',
      tone: 'bg-success/12 text-success',
    })),
    ...diff.removed.map((key) => ({
      key,
      sign: '-',
      kind: 'removed',
      tone: 'bg-destructive/12 text-destructive',
    })),
    ...diff.changed.map((key) => ({
      key,
      sign: '~',
      kind: 'changed',
      tone: 'bg-warning/12 text-warning',
    })),
  ];

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {total === 0
          ? 'Same keys and values. Only comments or formatting differ.'
          : `${diff.added.length} added · ${diff.removed.length} removed · ${diff.changed.length} changed`}
      </p>
      {total > 0 && (
        <ul aria-label="Keys changed since this version" className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <li
              key={`${chip.kind}:${chip.key}`}
              title={`${chip.kind} since this version`}
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-xs',
                chip.tone,
              )}
            >
              <span aria-hidden>{chip.sign}</span>
              <span className="sr-only">{chip.kind}: </span>
              <span>{chip.key}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Every version an env file had before a save replaced it, compared with the file as it is now.
 * Contents are decrypted one version at a time, only while the dialog is open, and kept in
 * component state rather than the query cache so they are gone once it closes.
 */
export function EnvFileHistoryDialog({
  open,
  onOpenChange,
  environment,
  file,
  onRestored,
}: EnvFileHistoryDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<string | null>(null);
  const [view, setView] = useState<'changes' | 'full'>('changes');
  const [current, setCurrent] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [unreadable, setUnreadable] = useState<ReadonlySet<string>>(new Set());
  const [restoring, setRestoring] = useState(false);
  const optionRefs = useRef(new Map<string, HTMLDivElement>());
  const focusAfterMove = useRef(false);

  const historyQuery = useQuery({
    queryKey: queryKeys.envFileHistory(file.id),
    queryFn: () => window.runova.environments.fileHistory(environment.id, file.id),
    enabled: open,
    // A save made a moment ago must show up, so never trust the app-wide cache time here.
    staleTime: 0,
  });
  const versions = historyQuery.data ?? [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset once per open, not on refetches
  useEffect(() => {
    if (!open) return;
    setPicked(null);
    setView('changes');
    setCurrent(null);
    setContents({});
    setUnreadable(new Set());
    setRestoring(false);

    let cancelled = false;
    window.runova.environments
      .readFile(environment.id, file.id)
      .then((text) => {
        if (!cancelled) setCurrent(text);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toast.error(ipcErrorMessage(error, 'Could not open that file.'));
        onOpenChange(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, file.id]);

  const selectedId = picked ?? versions[0]?.id ?? CURRENT;
  const selectedVersion = versions.find((version) => version.id === selectedId);
  const isCurrent = !selectedVersion;
  const versionContent = selectedVersion ? contents[selectedVersion.id] : undefined;
  const versionUnreadable = selectedVersion ? unreadable.has(selectedVersion.id) : false;

  useEffect(() => {
    if (!open || !selectedVersion) return;
    const versionId = selectedVersion.id;
    if (contents[versionId] !== undefined || unreadable.has(versionId)) return;
    let cancelled = false;
    window.runova.environments
      .readFileVersion(environment.id, file.id, versionId)
      .then((text) => {
        if (!cancelled) setContents((loaded) => ({ ...loaded, [versionId]: text }));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setUnreadable((failed) => new Set(failed).add(versionId));
        toast.error(ipcErrorMessage(error, 'Could not open that version.'));
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedVersion, contents, unreadable, environment.id, file.id]);

  const timeline: TimelineEntry[] = [
    {
      id: CURRENT,
      label: originLabel(file.origin),
      fileName: file.fileName,
      keyCount: file.keyCount,
      savedAt: file.updatedAt,
    },
    ...versions.map((version: EnvFileVersionSummary) => ({
      id: version.id,
      label: originLabel(version.origin),
      fileName: version.fileName,
      keyCount: version.keyCount,
      savedAt: version.savedAt,
    })),
  ];

  useEffect(() => {
    if (!focusAfterMove.current) return;
    focusAfterMove.current = false;
    optionRefs.current.get(selectedId)?.focus();
  }, [selectedId]);

  function moveSelection(event: React.KeyboardEvent): void {
    const index = timeline.findIndex((entry) => entry.id === selectedId);
    let next = index;
    if (event.key === 'ArrowDown') next = Math.min(index + 1, timeline.length - 1);
    else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = timeline.length - 1;
    else return;
    event.preventDefault();
    focusAfterMove.current = true;
    setPicked(timeline[next].id);
  }

  const identical = versionContent !== undefined && current !== null && versionContent === current;
  const canRestore =
    !isCurrent && versionContent !== undefined && current !== null && !identical && !restoring;

  async function restore(): Promise<void> {
    if (!selectedVersion || versionContent === undefined || !canRestore) return;
    const when = exactTime(selectedVersion.savedAt);
    const renamed = selectedVersion.fileName !== file.fileName;
    const confirmed = await confirmDialog({
      title: `Restore the version from ${when}?`,
      description: `${file.fileName} gets the contents it had then. The current contents are kept in the history, so you can undo this.${renamed ? ` The file keeps its name, ${file.fileName}.` : ''}`,
      confirmLabel: 'Restore',
    });
    if (!confirmed) return;
    setRestoring(true);
    try {
      await window.runova.environments.restoreFileVersion(
        environment.id,
        file.id,
        selectedVersion.id,
      );
      toast.success(`${file.fileName} restored to the version from ${when}.`);
      setCurrent(versionContent);
      setPicked(CURRENT);
      void queryClient.invalidateQueries({ queryKey: queryKeys.envFileHistory(file.id) });
      onRestored();
    } catch (error) {
      toast.error(ipcErrorMessage(error, 'Could not restore that version.'));
    } finally {
      setRestoring(false);
    }
  }

  const count = versions.length;
  const empty = historyQuery.isSuccess && count === 0;

  function renderPreview(): React.JSX.Element {
    if (versionUnreadable) {
      return (
        <div
          className={cn(
            EDITOR_HEIGHT,
            'flex items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground',
          )}
        >
          Could not open this version.
        </div>
      );
    }
    if (current === null || (!isCurrent && versionContent === undefined)) {
      return <Skeleton className={cn(EDITOR_HEIGHT, 'w-full rounded-lg')} />;
    }
    if (isCurrent || identical || view === 'full') {
      return (
        <MonacoEditor
          value={isCurrent ? current : (versionContent ?? '')}
          readOnly
          language="ini"
          className={EDITOR_HEIGHT}
        />
      );
    }
    return (
      <MonacoDiffEditor
        path={`env-history/${selectedId}.ini`}
        original={versionContent ?? ''}
        modified={current}
        sideBySide
        ignoreWhitespace={false}
        className={EDITOR_HEIGHT}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>History of {file.fileName}</DialogTitle>
          <DialogDescription>
            {environment.name} · {count} earlier {count === 1 ? 'version' : 'versions'}, newest
            first. They stay encrypted on this computer.
          </DialogDescription>
        </DialogHeader>

        {historyQuery.isLoading && (
          <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
            <Skeleton className="h-[360px] w-full" />
            <Skeleton className={cn(EDITOR_HEIGHT, 'w-full')} />
          </div>
        )}

        {historyQuery.isError && (
          <p className="text-sm text-destructive">
            {ipcErrorMessage(historyQuery.error, 'Could not load the history.')}
          </p>
        )}

        {empty && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-12 text-center">
            <History className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">No earlier versions yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Each time you save, import over, rename or restore this file, the version it replaces
              is kept here.
            </p>
          </div>
        )}

        {historyQuery.isSuccess && count > 0 && (
          <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
            <div
              role="listbox"
              aria-label="Versions"
              onKeyDown={moveSelection}
              className="flex max-h-[180px] flex-col gap-1 overflow-y-auto md:max-h-[420px]"
            >
              {timeline.map((entry) => {
                const selected = entry.id === selectedId;
                return (
                  <div
                    key={entry.id}
                    ref={(node) => {
                      if (node) optionRefs.current.set(entry.id, node);
                      else optionRefs.current.delete(entry.id);
                    }}
                    role="option"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setPicked(entry.id)}
                    onKeyDown={(event) => event.key === 'Enter' && setPicked(entry.id)}
                    className={cn(
                      'cursor-pointer rounded-md px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                      selected
                        ? 'bg-primary/15 text-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {entry.id === CURRENT && (
                        <span className="rounded-full bg-primary/20 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-primary">
                          Current
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {entry.label}
                      </span>
                      <span className="shrink-0 text-xs" title={exactTime(entry.savedAt)}>
                        {relativeTime(entry.savedAt)}
                      </span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {keysLabel(entry.keyCount)}
                      {entry.fileName !== file.fileName && (
                        <>
                          {' · was '}
                          <span className="font-mono">{entry.fileName}</span>
                        </>
                      )}
                    </p>
                  </div>
                );
              })}
            </div>

            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">
                  {isCurrent ? 'Current' : originLabel(selectedVersion?.origin)}
                  <span className="font-normal text-muted-foreground">
                    {' · '}
                    {exactTime(isCurrent ? file.updatedAt : (selectedVersion?.savedAt ?? 0))}
                  </span>
                </p>
                {!isCurrent && !identical && (
                  <div className="ml-auto flex rounded-md bg-secondary/40 p-0.5">
                    <Button
                      size="sm"
                      variant={view === 'changes' ? 'secondary' : 'ghost'}
                      aria-pressed={view === 'changes'}
                      className="h-7"
                      onClick={() => setView('changes')}
                    >
                      Changes
                    </Button>
                    <Button
                      size="sm"
                      variant={view === 'full' ? 'secondary' : 'ghost'}
                      aria-pressed={view === 'full'}
                      className="h-7"
                      onClick={() => setView('full')}
                    >
                      Full file
                    </Button>
                  </div>
                )}
              </div>

              {isCurrent && (
                <p className="text-xs text-muted-foreground">
                  This is the file as it is saved now.
                </p>
              )}
              {identical && (
                <p className="text-xs text-muted-foreground">Identical to the current file.</p>
              )}
              {!isCurrent && !identical && versionContent !== undefined && current !== null && (
                <KeyChips before={versionContent} after={current} />
              )}

              {renderPreview()}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {historyQuery.isSuccess && count > 0 && (
            <Button disabled={!canRestore} onClick={() => void restore()}>
              {restoring ? (
                <Spinner className="h-4 w-4 animate-spin" />
              ) : (
                <Undo className="h-3.5 w-3.5" />
              )}
              Restore this version
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
