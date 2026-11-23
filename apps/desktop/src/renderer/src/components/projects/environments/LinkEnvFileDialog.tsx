import type { EnvFileSummary, EnvLinkPreview, ProjectEnvironment } from '@shared/apiTypes';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CircleAlert, FileText, FolderOpen, History, Link, Spinner } from '@/components/icons';
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
import { ipcErrorMessage } from './ipcError';

export interface LinkEnvFileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  environment: ProjectEnvironment;
  file: EnvFileSummary;
  onLinked: () => void;
}

interface Choice {
  /** Relative to the project folder, with forward slashes. */
  path: string;
  /** A short note under the path, such as the size or "picked". */
  note: string;
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

type Preview =
  | { status: 'loading' }
  | { status: 'ready'; preview: EnvLinkPreview }
  | { status: 'error'; message: string };

/**
 * Links a saved env file to a file in the project. The .env files in the project root are
 * offered first, the one with the same name already picked; any other file in the project can
 * be chosen with the system picker. Before linking, it says what happens to the saved copy.
 */
export function LinkEnvFileDialog({
  open,
  onOpenChange,
  projectId,
  environment,
  file,
  onLinked,
}: LinkEnvFileDialogProps): React.JSX.Element {
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [picking, setPicking] = useState(false);
  const [linking, setLinking] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scan once per open
  useEffect(() => {
    if (!open) return;
    setChoices(null);
    setScanError(null);
    setSelected(null);
    setPreview(null);
    setLinking(false);
    let cancelled = false;
    window.runova.environments
      .scanFolder(projectId)
      .then((files) => {
        if (cancelled) return;
        const usable = files.filter((found) => !found.tooLarge);
        const found = usable.map((one) => ({
          path: one.fileName,
          note: `${formatSize(one.size)}${one.isTemplate ? ' · looks like a template' : ''}`,
        }));
        // A file already linked (maybe on another computer, waiting to be confirmed here) starts
        // on the file it points at, so confirming is one look and one click.
        const current = file.link?.path;
        setChoices(
          current && !found.some((choice) => choice.path === current)
            ? [...found, { path: current, note: 'Linked now' }]
            : found,
        );
        setSelected(
          current ?? usable.find((one) => one.fileName === file.fileName)?.fileName ?? null,
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) setScanError(ipcErrorMessage(error, 'Could not read the project folder.'));
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, file.id]);

  useEffect(() => {
    if (!open || !selected) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview({ status: 'loading' });
    window.runova.environments
      .inspectLinkFile(environment.id, file.id, selected)
      .then((result) => {
        if (!cancelled) setPreview({ status: 'ready', preview: result });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPreview({
            status: 'error',
            message: ipcErrorMessage(error, 'Could not read that file.'),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, selected, environment.id, file.id]);

  async function chooseAnother(): Promise<void> {
    setPicking(true);
    try {
      const path = await window.runova.environments.pickLinkFile(projectId);
      if (!path) return;
      setChoices((current) => {
        const list = current ?? [];
        return list.some((choice) => choice.path === path)
          ? list
          : [...list, { path, note: 'Chosen from the project' }];
      });
      setSelected(path);
    } catch (error) {
      toast.error(ipcErrorMessage(error, 'Could not use that file.'));
    } finally {
      setPicking(false);
    }
  }

  async function handleLink(): Promise<void> {
    if (!selected || preview?.status !== 'ready' || linking) return;
    setLinking(true);
    try {
      await window.runova.environments.linkFile({
        environmentId: environment.id,
        fileId: file.id,
        path: selected,
      });
      toast.success(`${file.fileName} now follows ${preview.preview.path}.`);
      onOpenChange(false);
      onLinked();
    } catch (error) {
      toast.error(ipcErrorMessage(error, 'Could not link that file.'));
    } finally {
      setLinking(false);
    }
  }

  const canLink = selected !== null && preview?.status === 'ready' && !linking;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link {file.fileName} to a project file</DialogTitle>
          <DialogDescription>
            When the file changes on disk, {environment.name} saves the new contents as a new
            version. Saving the copy here writes the file too.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {scanError && <p className="text-sm text-destructive">{scanError}</p>}
          {!scanError && choices === null && (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
          )}
          {choices?.length === 0 && (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              No .env files in the project root. Choose any file in the project instead.
            </p>
          )}
          {choices && choices.length > 0 && (
            <fieldset className="flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto">
              <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
                Files in this project
              </legend>
              {choices.map((choice) => {
                const checked = choice.path === selected;
                return (
                  <label
                    key={choice.path}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 transition-colors',
                      'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                      checked
                        ? 'bg-primary/10 ring-1 ring-primary/60'
                        : 'border-border bg-secondary/30 hover:bg-accent',
                    )}
                  >
                    <input
                      type="radio"
                      name="env-link-target"
                      className="sr-only"
                      aria-label={choice.path}
                      checked={checked}
                      onChange={() => setSelected(choice.path)}
                    />
                    <FileText
                      className={cn(
                        'h-4 w-4 shrink-0',
                        checked ? 'text-primary' : 'text-muted-foreground',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-sm">{choice.path}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {choice.note}
                      </span>
                    </span>
                    {choice.path === file.fileName && (
                      <span className="shrink-0 text-xs text-muted-foreground">Same name</span>
                    )}
                  </label>
                );
              })}
            </fieldset>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={picking}
            onClick={() => void chooseAnother()}
          >
            {picking ? (
              <Spinner className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderOpen className="h-3.5 w-3.5" />
            )}
            Choose another file...
          </Button>

          {preview && (
            <div
              aria-live="polite"
              className="rounded-md border border-border bg-secondary/30 px-3 py-2.5 text-sm"
            >
              {preview.status === 'loading' && (
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Spinner className="h-3.5 w-3.5 animate-spin" /> Reading the file...
                </span>
              )}
              {preview.status === 'error' && (
                <span className="flex items-start gap-2 text-destructive">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {preview.message}
                </span>
              )}
              {preview.status === 'ready' && (
                <div className="flex flex-col gap-1">
                  <span className="flex items-center gap-2">
                    <Link className="h-3.5 w-3.5 text-primary" />
                    <span className="font-mono">{preview.preview.path}</span>
                    <span className="text-muted-foreground">
                      · {preview.preview.keyCount} {preview.preview.keyCount === 1 ? 'key' : 'keys'}
                    </span>
                  </span>
                  <span className="flex items-start gap-2 text-muted-foreground">
                    <History className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {preview.preview.sameAsSaved
                      ? 'Same contents as the saved copy, so no new version is added.'
                      : "This copy takes the file's contents now. What it holds today stays in History."}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canLink} onClick={() => void handleLink()}>
            {linking && <Spinner className="h-4 w-4 animate-spin" />}
            Link file
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
