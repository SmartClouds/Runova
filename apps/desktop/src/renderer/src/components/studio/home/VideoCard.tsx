import type { VideoSummary } from '@runova/studio';
import { useQueryClient } from '@tanstack/react-query';
import { studioClient } from '../client';
import { errorMessage, formatWhen } from '../format';
import {
  Button,
  Card,
  Chip,
  Clapperboard,
  cn,
  confirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EllipsisVertical,
  FolderOpen,
  GripVertical,
  Notice,
  Pin,
  persianTextProps,
  type ReorderMotion,
  SimpleTooltip,
  Trash2,
  toast,
} from '../kit';
import { studioKeys } from '../queryKeys';

/** The card's shape without its glass, so a card held by the pointer can swap in an opaque surface. */
const CARD_SHAPE = 'rounded-[calc(var(--radius)+2px)]';

/** Hidden until the card is hovered or focused, so a grid of cards stays quiet. */
const REVEAL =
  'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100';

/** A card that sits still: nothing to drag it with. */
const STILL: ReorderMotion = {
  itemProps: { 'data-reorder-id': '' },
  dragging: false,
  lifted: false,
  onGripPointerDown: () => undefined,
};

export interface VideoCardProps {
  video: VideoSummary;
  /** The linked project's name, when the card should say which project it belongs to. */
  projectName?: string | null;
  onOpen: (video: VideoSummary) => void;
  /** Where the card sits in its reorderable group; leave out for a card that does not move. */
  motion?: ReorderMotion;
  /**
   * Whether the grip can reorder now. False shows it dimmed with `dragHint`, for a filtered list
   * whose order would not say where a card lands among the hidden ones. Leave out for no grip.
   */
  draggable?: boolean;
  dragHint?: string;
  /** Pins the video to the top of the library or lets it go; leave out for no pin button. */
  onTogglePin?: () => void;
}

/** The only part of the card that starts a drag, so a click anywhere else is never one. */
function DragGrip({
  enabled,
  hint,
  onPointerDown,
}: {
  enabled: boolean;
  hint: string;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
}): React.JSX.Element {
  if (!enabled) {
    return (
      <SimpleTooltip label={hint} wrapTrigger>
        <span
          onClick={(event) => event.stopPropagation()}
          className={cn(
            'flex h-7 w-7 shrink-0 cursor-not-allowed items-center justify-center rounded-full text-muted-foreground/25',
            REVEAL,
          )}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
      </SimpleTooltip>
    );
  }
  return (
    <SimpleTooltip label="Drag to reorder">
      <span
        data-drag-grip
        role="img"
        aria-label="Drag to reorder"
        onPointerDown={onPointerDown}
        onClick={(event) => event.stopPropagation()}
        className={cn(
          'flex h-7 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-full text-muted-foreground/50 transition-[opacity,background-color] hover:bg-foreground/[0.08] hover:text-foreground active:cursor-grabbing',
          REVEAL,
        )}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </span>
    </SimpleTooltip>
  );
}

/**
 * One video in the library, on the same card a project sits on: open it, find its folder, move
 * it, pin it, drag it to another place, or take it off the list.
 */
export function VideoCard({
  video,
  projectName,
  onOpen,
  motion = STILL,
  draggable,
  dragHint = 'Show all videos to reorder them',
  onTogglePin,
}: VideoCardProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: studioKeys.videos });
  const titleProps = persianTextProps(video.title);
  const openable = !video.missing;

  async function locate() {
    const folder = await studioClient().pickFolder();
    if (!folder) return;
    try {
      await studioClient().locate(video.id, folder);
      toast.success('Found it. The video opens from its new place.');
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function move() {
    const toRoot = await studioClient().pickFolder();
    if (!toRoot) return;
    try {
      const result = await studioClient().move(video.id, toRoot);
      await refresh();
      const removeOld = await confirmDialog({
        title: 'Video moved',
        description: `It now lives in ${result.video.folder}. The old copy is still in ${result.oldFolder}.`,
        confirmLabel: 'Move old copy to the trash',
        cancelLabel: 'Keep it',
        variant: 'destructive',
      });
      if (removeOld) await studioClient().trashOldFolder(result.oldFolder);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `Remove "${video.title}" from Studio?`,
      description:
        'Its folder and files stay where they are. You can add it back with Add existing folder.',
      confirmLabel: 'Remove from library',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await studioClient().removeFromLibrary(video.id);
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const pinLabel = video.pinned ? 'Unpin video' : 'Pin to top';

  return (
    // The whole card opens the video, like a project card. The title stays a real button so the
    // keyboard can reach it, and the actions stop their clicks so they never open the video.
    <Card
      {...motion.itemProps}
      role="article"
      aria-label={video.title}
      className={cn(
        CARD_SHAPE,
        'group relative flex flex-col',
        openable && 'cursor-pointer',
        // While it's held, the card turns near-opaque so the cards it passes don't show through.
        motion.dragging
          ? 'glass-opaque z-10 ring-1 ring-primary/40 transition-none'
          : 'glass transition-[transform,box-shadow,opacity] duration-200 ease-out motion-reduce:transition-none',
        // A ring rather than a border colour: the card's glass edge is unlayered CSS and would win.
        openable &&
          'hover:-translate-y-0.5 hover:ring-1 hover:ring-primary/30 focus-within:ring-1 focus-within:ring-primary/30 motion-reduce:hover:translate-y-0',
      )}
      onClick={openable ? () => onOpen(video) : undefined}
    >
      {video.pinned && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-[1.6rem] h-5 w-[3px] rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]"
        />
      )}
      <div className="space-y-3 p-4 pb-3">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
            <Clapperboard className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 flex-1 pt-px">
            <button
              type="button"
              disabled={video.missing}
              onClick={(event) => {
                event.stopPropagation();
                onOpen(video);
              }}
              className={cn(
                'block max-w-full truncate rounded-sm text-left text-sm font-semibold leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                openable ? 'cursor-pointer' : 'cursor-default',
              )}
            >
              <span dir={titleProps.dir} className={titleProps.className}>
                {video.title}
              </span>
            </button>
            <p className="mt-1 text-xs text-muted-foreground">
              {video.lastOpenedAt
                ? `Opened ${formatWhen(video.lastOpenedAt)}`
                : `Created ${formatWhen(video.createdAt)}`}
            </p>
          </div>
          {/* The menu content is portaled, but React still bubbles its clicks up to the card. */}
          <div
            className="-mr-1 -mt-0.5 flex shrink-0 items-center"
            onClick={(event) => event.stopPropagation()}
          >
            {draggable !== undefined && (
              <DragGrip
                enabled={draggable}
                hint={dragHint}
                onPointerDown={motion.onGripPointerDown}
              />
            )}
            {onTogglePin && (
              <SimpleTooltip label={pinLabel}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={pinLabel}
                  aria-pressed={video.pinned}
                  className={cn(
                    REVEAL,
                    video.pinned && 'text-primary opacity-100 hover:text-primary',
                  )}
                  onClick={onTogglePin}
                >
                  <Pin className="h-3.5 w-3.5" />
                </Button>
              </SimpleTooltip>
            )}
            <DropdownMenu>
              <SimpleTooltip label="More">
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`More for ${video.title}`}>
                    <EllipsisVertical />
                  </Button>
                </DropdownMenuTrigger>
              </SimpleTooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={video.missing}
                  onSelect={() => void studioClient().revealVideo(video.id)}
                >
                  <FolderOpen /> Open folder
                </DropdownMenuItem>
                <DropdownMenuItem disabled={video.missing} onSelect={() => void move()}>
                  <FolderOpen /> Move to another folder...
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void remove()}>
                  <Trash2 /> Remove from library
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {projectName !== undefined && (
          <div className="flex flex-wrap gap-1.5">
            <Chip tone={video.linkedProjectId ? 'primary' : 'neutral'}>
              {video.linkedProjectId ? (projectName ?? 'Removed project') : 'Standalone'}
            </Chip>
          </div>
        )}
        {video.missing && (
          <Notice
            tone="warning"
            size="sm"
            action={
              <Button size="xs" variant="outline" onClick={() => void locate()}>
                Locate
              </Button>
            }
          >
            The folder is gone. It may have been moved or renamed.
          </Notice>
        )}
      </div>
    </Card>
  );
}
