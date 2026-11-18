import { filesLabel, type StagedItem } from '@shared/fileSend';
import { formatBytes } from '@shared/remoteProtocol';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useRef, useState } from 'react';
import { Folder, FolderPlus, Paperclip, Plus, Upload, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { persianTextProps } from '@/lib/rtl';
import { cn } from '@/lib/utils';
import { fileKind, KIND_LOOK } from './fileKinds';

/** True while the drag carries files, so dragging text around does not light the zone. */
function carriesFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Where files and folders to send are gathered (E112): dropped from anywhere on the computer, or
 * picked. Paths come from `shell.pathForFile`, since Electron no longer exposes `File.path`, and
 * go straight to main, which keeps them; this only shows names and sizes.
 */
export function SendDropZone({
  staged,
  onPaths,
  onPickFiles,
  onPickFolder,
  onRemove,
  onClear,
}: {
  staged: StagedItem[];
  onPaths: (paths: string[]) => void;
  onPickFiles: () => void;
  onPickFolder: () => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}): React.JSX.Element {
  const [over, setOver] = useState(false);
  /** Enters minus leaves: moving onto a row inside fires one of each, and must not count as leaving. */
  const depth = useRef(0);
  const reduce = useReducedMotion();
  const fileCount = staged.reduce((sum, item) => sum + item.fileCount, 0);
  const size = staged.reduce((sum, item) => sum + item.size, 0);

  return (
    <section
      aria-label="Files to send"
      className="relative"
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return;
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        if (!carriesFiles(event)) return;
        const paths = Array.from(event.dataTransfer?.files ?? [])
          .map((file) => window.runova.shell.pathForFile(file))
          .filter(Boolean);
        if (paths.length > 0) onPaths(paths);
      }}
    >
      {staged.length === 0 ? (
        <div
          className={cn(
            'flex flex-col items-center gap-3 rounded-xl bg-foreground/[0.025] px-6 py-9 text-center transition-colors',
            // An outline rather than a border, so the dashes take the theme's tint.
            'outline-1 -outline-offset-1 outline-dashed outline-foreground/15',
          )}
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary">
            <Upload className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">Drop files or folders here</p>
            <p className="text-xs text-muted-foreground">
              A folder arrives as it is, with everything inside it.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Button type="button" variant="soft" shape="pill" onClick={onPickFiles}>
              <Paperclip />
              Choose files
            </Button>
            <Button type="button" variant="soft" shape="pill" onClick={onPickFolder}>
              <FolderPlus />
              Choose folder
            </Button>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-foreground/[0.025] ring-1 ring-inset ring-foreground/[0.07]">
          <ul aria-label="Staged" className="settings-rows rail-scroll max-h-64 overflow-y-auto">
            <AnimatePresence initial={false}>
              {staged.map((item) => (
                <motion.li
                  key={item.id}
                  layout={!reduce}
                  initial={reduce ? false : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, x: 12 }}
                  transition={{ duration: 0.18 }}
                  className="group flex items-center gap-3 px-3 py-2"
                >
                  <StagedTile item={item} />
                  <div className="min-w-0 flex-1">
                    <div
                      className="truncate text-[13px] font-medium"
                      {...persianTextProps(item.name)}
                    >
                      {item.name}
                    </div>
                    <div className="text-xs tabular-nums text-muted-foreground">
                      {item.kind === 'folder'
                        ? `${filesLabel(item.fileCount)}, ${formatBytes(item.size)}`
                        : formatBytes(item.size)}
                    </div>
                  </div>
                  <SimpleTooltip label="Remove">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      shape="pill"
                      aria-label={`Remove ${item.name}`}
                      className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                      onClick={() => onRemove(item.id)}
                    >
                      <X />
                    </Button>
                  </SimpleTooltip>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]">
            <span className="mr-auto text-xs tabular-nums text-muted-foreground">
              {`${filesLabel(fileCount)}, ${formatBytes(size)}`}
            </span>
            <Button type="button" size="xs" variant="ghost" shape="pill" onClick={onPickFiles}>
              <Plus />
              Add files
            </Button>
            <Button type="button" size="xs" variant="ghost" shape="pill" onClick={onPickFolder}>
              <Folder />
              Add folder
            </Button>
            <Button type="button" size="xs" variant="ghost" shape="pill" onClick={onClear}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {over ? (
        <div
          aria-hidden
          className={cn(
            'glass pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-xl',
            'outline-2 -outline-offset-2 outline-dashed outline-primary/60',
          )}
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary shadow-[0_0_40px_-10px_hsl(var(--primary)/0.8)]">
            <Upload className="h-5 w-5" />
          </div>
          <p className="text-sm font-medium">Drop to add</p>
        </div>
      ) : null}
    </section>
  );
}

function StagedTile({ item }: { item: StagedItem }): React.JSX.Element {
  const look = KIND_LOOK[item.kind === 'folder' ? 'folder' : fileKind(item.name)];
  return (
    <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', look.tile)}>
      <look.Icon className="h-3.5 w-3.5" />
      <span className="sr-only">{look.label}</span>
    </span>
  );
}
