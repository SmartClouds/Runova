import type { VideoSummary } from '@runova/studio';
import { useQueryClient } from '@tanstack/react-query';
import { studioClient } from '../client';
import { errorMessage } from '../format';
import {
  CARD_GRID,
  CatalogCardShimmer,
  Clapperboard,
  cn,
  EmptyState,
  LoadFailure,
  Pin,
  ReorderableGroup,
  SECTION_HEADING,
  toast,
} from '../kit';
import { studioKeys } from '../queryKeys';
import { VideoCard } from './VideoCard';

export interface VideoGridProps {
  videos: VideoSummary[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onOpen: (video: VideoSummary) => void;
  /** Project names by id, for the chip on each card; leave out to hide the chip. */
  projectNames?: Map<string, string>;
  /**
   * Whether dragging a card saves a new order. False while the list is filtered, since the order
   * would not say where a card lands among the hidden videos; leave out for no grips at all.
   */
  reorderable?: boolean;
  /** What the empty state offers, usually a New video button. */
  emptyAction?: React.ReactNode;
  emptyDescription?: string;
}

function GroupHeading({
  icon,
  count,
  children,
}: {
  icon?: React.ReactNode;
  count: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1">
      <h2 className={cn(SECTION_HEADING, 'flex items-center gap-1.5')}>
        {icon}
        {children}
      </h2>
      <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[10px] leading-4 tabular-nums text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

/**
 * The library's cards, with a shimmer per card while loading. Pinned videos sit in a group of
 * their own on top, and the cards in each group can be dragged into another order, like projects.
 */
export function VideoGrid({
  videos,
  loading,
  error,
  onRetry,
  onOpen,
  projectNames,
  reorderable,
  emptyAction,
  emptyDescription = 'Make your first one: write a brief, get a scenario, and edit it into a video.',
}: VideoGridProps): React.JSX.Element {
  const queryClient = useQueryClient();

  if (error)
    return (
      <LoadFailure message={`Your videos did not load. ${errorMessage(error)}`} retry={onRetry} />
    );
  if (loading || !videos) {
    return (
      <div className="@container/grid">
        <div className={CARD_GRID} aria-busy="true" aria-label="Loading videos">
          {Array.from({ length: 6 }, (_, i) => (
            <CatalogCardShimmer key={i} />
          ))}
        </div>
      </div>
    );
  }
  if (videos.length === 0) {
    return (
      <EmptyState
        card
        icon={Clapperboard}
        title="No videos yet"
        description={emptyDescription}
        action={emptyAction}
      />
    );
  }

  const pinned = videos.filter((v) => v.pinned);
  const rest = videos.filter((v) => !v.pinned);
  const refresh = () => queryClient.invalidateQueries({ queryKey: studioKeys.videos });

  async function save(order: VideoSummary[]) {
    try {
      await studioClient().reorder(order.map((v) => v.id));
    } catch (error) {
      toast.error(errorMessage(error));
    }
    await refresh();
  }

  /** A drop landed one video at another place within its group; the rest of the order holds. */
  function moveWithin(group: 'pinned' | 'rest', from: number, to: number) {
    const moved = [...(group === 'pinned' ? pinned : rest)];
    const [video] = moved.splice(from, 1);
    if (!video) return;
    moved.splice(to, 0, video);
    void save(group === 'pinned' ? [...moved, ...rest] : [...pinned, ...moved]);
  }

  async function togglePin(video: VideoSummary) {
    try {
      await studioClient().setPinned(video.id, !video.pinned);
    } catch (error) {
      toast.error(errorMessage(error));
    }
    await refresh();
  }

  const renderGroup = (group: 'pinned' | 'rest', items: VideoSummary[]) => (
    <ReorderableGroup
      items={items}
      getId={(video) => video.id}
      enabled={reorderable === true}
      className={CARD_GRID}
      onMove={(from, to) => moveWithin(group, from, to)}
      renderItem={(video, motion) => (
        <VideoCard
          video={video}
          onOpen={onOpen}
          motion={motion}
          draggable={reorderable}
          onTogglePin={() => void togglePin(video)}
          projectName={
            projectNames
              ? video.linkedProjectId
                ? (projectNames.get(video.linkedProjectId) ?? null)
                : null
              : undefined
          }
        />
      )}
    />
  );

  return (
    <div className="@container/grid space-y-5">
      {pinned.length > 0 && (
        <section className="space-y-2" aria-label="Pinned videos">
          <GroupHeading icon={<Pin className="h-3 w-3 text-primary" />} count={pinned.length}>
            Pinned
          </GroupHeading>
          {renderGroup('pinned', pinned)}
        </section>
      )}
      {rest.length > 0 && (
        <section className="space-y-2" aria-label={pinned.length > 0 ? 'Other videos' : 'Videos'}>
          {pinned.length > 0 && <GroupHeading count={rest.length}>All videos</GroupHeading>}
          {renderGroup('rest', rest)}
        </section>
      )}
    </div>
  );
}
