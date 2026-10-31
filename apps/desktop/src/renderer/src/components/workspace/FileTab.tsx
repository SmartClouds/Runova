import type { Project } from '@runova/core';
import { isImagePath, isTextImagePath } from '@shared/imageFiles';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { languageFor, MonacoDiffEditor } from '@/components/editor/MonacoDiffEditor';
import { MonacoEditor } from '@/components/editor/MonacoEditor';
import { ExternalLink, File, ImageIcon, RefreshCw, Save, Spinner, X } from '@/components/icons';
import { Chip, EmptyState, Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useEditorRevealStore } from '@/stores/editorRevealStore';
import { setFileDirty } from '@/stores/explorerStore';
import { useWorkspaceStore, type WorkspaceFileTab } from '@/stores/workspaceStore';
import { ImageFileTab } from './ImageFileTab';
import { useFileDiskChanges } from './useFileDiskChanges';

/** Files past this open read-only: Monaco copes, but editing a multi-megabyte file here is a trap. */
const MAX_EDITABLE_CHARS = 2_000_000;

/**
 * What the bar over the editor says after the file changed on disk: it was reloaded (there were
 * no unsaved edits to lose), it changed under unsaved edits (`text` is the new version), or it
 * was deleted.
 */
type DiskNotice = { kind: 'reloaded' } | { kind: 'conflict'; text: string } | { kind: 'deleted' };

export function fileQueryKey(path: string): readonly unknown[] {
  return queryKeys.workspaceFile(path);
}

/**
 * A project file in a tab. A picture opens in the viewer; everything else, including an SVG
 * the viewer was asked to hand over, opens in the editor.
 */
export default function FileTab({
  project,
  tab,
}: {
  project: Project;
  tab: WorkspaceFileTab;
}): React.JSX.Element {
  const [asText, setAsText] = useState(false);

  // Reusing the tab for another file starts back at the viewer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the path is the trigger, not a read
  useEffect(() => {
    setAsText(false);
  }, [tab.path]);

  // A preview tab keeps its id while the file in it changes, so each file gets fresh state
  // (draft, save, image size) instead of inheriting the last one's.
  if (isImagePath(tab.path) && !asText) {
    return (
      <ImageFileTab
        key={tab.path}
        project={project}
        tab={tab}
        onEditSource={isTextImagePath(tab.path) ? () => setAsText(true) : undefined}
      />
    );
  }
  return (
    <TextFileTab
      key={tab.path}
      project={project}
      tab={tab}
      onShowImage={isImagePath(tab.path) ? () => setAsText(false) : undefined}
    />
  );
}

/**
 * A file in an editor. Ctrl+S saves. When the file changes on disk, a clean file reloads and says
 * so, and a file with unsaved edits keeps them and asks which version to keep.
 */
function TextFileTab({
  project,
  tab,
  onShowImage,
}: {
  project: Project;
  tab: WorkspaceFileTab;
  /** Set for an image shown as source, to go back to the picture. */
  onShowImage?: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const openFile = useWorkspaceStore((s) => s.openFile);
  const file = useQuery({
    queryKey: fileQueryKey(tab.path),
    queryFn: () => window.runova.fs.readFile(tab.path),
    meta: { silentLoading: true },
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [diskNotice, setDiskNotice] = useState<DiskNotice | null>(null);
  const [comparing, setComparing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dirty = draft !== null && draft !== file.data;
  // A change on disk is handled after an await, by which time the draft may have moved on.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const conflict = diskNotice?.kind === 'conflict' ? diskNotice : null;
  const tooLarge = (file.data?.length ?? 0) > MAX_EDITABLE_CHARS;
  // A search result opened here asks for its line; the editor takes it once it has the text.
  const reveal = useEditorRevealStore((s) => s.pending[tab.path] ?? null);
  const takeReveal = useCallback(
    () => void useEditorRevealStore.getState().takeReveal(tab.path),
    [tab.path],
  );

  // The explorer warns before deleting a file that has unsaved edits here.
  useEffect(() => {
    setFileDirty(tab.path, dirty);
    return () => setFileDirty(tab.path, false);
  }, [tab.path, dirty]);

  const relative = tab.path.startsWith(project.folderPath)
    ? tab.path.slice(project.folderPath.length).replace(/^[\\/]/, '')
    : tab.path;
  const parts = relative.split(/[\\/]/);
  const name = parts.pop() ?? relative;
  const dir = parts.join('/');

  function clearDiskNotice(): void {
    setDiskNotice(null);
    setComparing(false);
  }

  useFileDiskChanges(tab.path, (change) => {
    if (!change.exists) {
      setDiskNotice({ kind: 'deleted' });
      setComparing(false);
      return;
    }
    void (async () => {
      let text: string;
      try {
        text = await window.runova.fs.readFile(tab.path);
      } catch {
        // Gone again, or locked mid-write. The next change says more.
        return;
      }
      const key = fileQueryKey(tab.path);
      const shown = queryClient.getQueryData<string>(key);
      const edits = draftRef.current;
      if (text === shown) {
        // Nothing new to show: our own save, or a file that came back as it was.
        setDiskNotice((notice) => (notice?.kind === 'deleted' ? null : notice));
        return;
      }
      if (edits === null || edits === shown || edits === text) {
        // No edits to lose (or the disk now says exactly what they say), so just follow it.
        queryClient.setQueryData(key, text);
        setDraft(null);
        setComparing(false);
        setDiskNotice(edits === text ? null : { kind: 'reloaded' });
        return;
      }
      setDiskNotice({ kind: 'conflict', text });
    })();
  });

  /** Drops the unsaved edits for the version on disk. */
  function takeDiskVersion(text: string): void {
    queryClient.setQueryData(fileQueryKey(tab.path), text);
    setDraft(null);
    clearDiskNotice();
  }

  /** Keeps the edits, with the version on disk as what they are now measured against. */
  function keepEdits(text: string): void {
    queryClient.setQueryData(fileQueryKey(tab.path), text);
    clearDiskNotice();
  }

  // A file deleted on disk can be saved back as it is shown, edits or not.
  const deleted = diskNotice?.kind === 'deleted';
  const canSave = (dirty || deleted) && !saving;

  async function save(): Promise<void> {
    const content = draft ?? file.data;
    if (!canSave || content === undefined) return;
    setSaving(true);
    try {
      await window.runova.fs.writeFile(tab.path, content);
      queryClient.setQueryData(fileQueryKey(tab.path), content);
      setDraft(null);
      clearDiskNotice();
    } catch (error) {
      toast.error('Could not save the file', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  }

  // Ctrl/Cmd+S saves while focus is anywhere in this tab.
  // biome-ignore lint/correctness/useExhaustiveDependencies: save reads the latest draft
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.code === 'KeyS') {
        event.preventDefault();
        event.stopPropagation();
        void save();
      }
    };
    el.addEventListener('keydown', onKeyDown, true);
    return () => el.removeEventListener('keydown', onKeyDown, true);
  }, [draft, file.data, saving, diskNotice]);

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]">
        <File className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="min-w-[3rem] shrink truncate text-xs font-medium">{name}</span>
        {dir ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground [direction:rtl]">
            <bdi>{dir}</bdi>
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {dirty ? (
          <Chip tone="warning" dot>
            Unsaved
          </Chip>
        ) : null}
        {onShowImage ? (
          <SimpleTooltip label="Show the picture">
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label="Show the picture"
              onClick={onShowImage}
            >
              <ImageIcon />
            </Button>
          </SimpleTooltip>
        ) : null}
        <SimpleTooltip label="Reload from disk">
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Reload from disk"
            onClick={() => {
              setDraft(null);
              clearDiskNotice();
              void file.refetch();
            }}
          >
            <RefreshCw className={cn('h-2.5 w-2.5', file.isFetching && 'animate-spin')} />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Open in its default app">
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Open in its default app"
            onClick={() => void window.runova.shell.openPath(tab.path)}
          >
            <ExternalLink />
          </Button>
        </SimpleTooltip>
        <Button type="button" size="xs" onClick={() => void save()} disabled={!canSave}>
          {saving ? <Spinner className="animate-spin" /> : <Save />}
          Save
        </Button>
      </div>
      {diskNotice ? (
        <DiskNoticeBar
          name={name}
          notice={diskNotice}
          comparing={comparing}
          onDismiss={clearDiskNotice}
          onTakeDisk={takeDiskVersion}
          onKeepEdits={keepEdits}
          onToggleCompare={() => setComparing((on) => !on)}
        />
      ) : null}
      <div className="relative min-h-0 flex-1">
        {file.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 12 }, (_, i) => (
              <Skeleton
                key={i}
                className="h-3.5 rounded"
                style={{ width: `${35 + ((i * 41) % 60)}%` }}
              />
            ))}
          </div>
        ) : file.isError ? (
          <EmptyState
            size="sm"
            icon={File}
            title="This file could not be opened"
            description={
              file.error instanceof Error
                ? file.error.message
                : 'It may have been moved or deleted.'
            }
            className="h-full"
          />
        ) : conflict && comparing ? (
          // The version on disk on the left, the edits on the right, where they can be merged.
          <MonacoDiffEditor
            path={tab.path.replaceAll('\\', '/')}
            original={conflict.text}
            modified={draft ?? file.data ?? ''}
            sideBySide
            ignoreWhitespace={false}
            editable={!tooLarge}
            onModifiedChange={setDraft}
            className="absolute inset-0 min-h-0 rounded-none border-0"
          />
        ) : (
          <MonacoEditor
            value={draft ?? file.data ?? ''}
            onChange={(value) => {
              setDraft(value);
              // The note that the file was reloaded has done its job once the file is edited.
              setDiskNotice((notice) => (notice?.kind === 'reloaded' ? null : notice));
              // Editing a preview tab keeps it, so the edit isn't lost to the next file clicked.
              if (tab.preview) openFile(project.id, tab.path, { pin: true });
            }}
            language={languageFor(tab.path.replaceAll('\\', '/'))}
            readOnly={tooLarge}
            reveal={reveal}
            onRevealed={takeReveal}
            className="absolute inset-0 min-h-0 rounded-none border-0"
          />
        )}
      </div>
    </div>
  );
}

/**
 * The bar over the editor after the file changed on disk, the way VS Code and Visual Studio
 * say it: a quiet note when the file simply reloaded, a warning with a choice when the change
 * landed under unsaved edits, and a warning when the file is gone.
 */
function DiskNoticeBar({
  name,
  notice,
  comparing,
  onDismiss,
  onTakeDisk,
  onKeepEdits,
  onToggleCompare,
}: {
  name: string;
  notice: DiskNotice;
  comparing: boolean;
  onDismiss: () => void;
  onTakeDisk: (text: string) => void;
  onKeepEdits: (text: string) => void;
  onToggleCompare: () => void;
}): React.JSX.Element {
  const file = <span className="font-medium">{name}</span>;
  const barClass =
    'shrink-0 items-center rounded-none py-1.5 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]';
  const dismiss = (
    <SimpleTooltip label="Dismiss">
      <Button variant="ghost" size="icon-xs" type="button" aria-label="Dismiss" onClick={onDismiss}>
        <X />
      </Button>
    </SimpleTooltip>
  );

  if (notice.kind === 'reloaded') {
    return (
      <Notice tone="primary" size="sm" role="status" className={barClass} action={dismiss}>
        {file} changed on disk and was reloaded.
      </Notice>
    );
  }

  if (notice.kind === 'deleted') {
    return (
      <Notice tone="warning" size="sm" role="alert" className={barClass} action={dismiss}>
        {file} was deleted on disk. Saving will create it again.
      </Notice>
    );
  }

  return (
    <Notice
      tone="warning"
      size="sm"
      role="alert"
      className={barClass}
      action={
        <>
          <Button type="button" size="xs" variant="soft" onClick={() => onTakeDisk(notice.text)}>
            Show new version
          </Button>
          <Button
            type="button"
            size="xs"
            variant="soft"
            aria-pressed={comparing}
            className={cn(comparing && 'bg-foreground/10')}
            onClick={onToggleCompare}
          >
            Compare
          </Button>
          <Button type="button" size="xs" variant="soft" onClick={() => onKeepEdits(notice.text)}>
            Keep mine
          </Button>
        </>
      }
    >
      {file} changed on disk. Your edits are not saved.
      {comparing ? (
        <span className="text-muted-foreground">
          {' '}
          Left is the file on disk, right is your version, which you can edit here.
        </span>
      ) : null}
    </Notice>
  );
}
