import type { HistoryEntryView } from '@runova/studio';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AiRunsList, type AiRunsListProps } from '../ai/AiRunsList';
import { CompareRunsDialog } from '../ai/CompareRunsDialog';
import { studioClient } from '../client';
import { errorMessage, formatWhen, groupByDay } from '../format';
import {
  Button,
  ChevronRight,
  Chip,
  cn,
  confirmDialog,
  FileText,
  GLASS_PANEL,
  History,
  LoadFailure,
  SECTION_HEADING,
  SEGMENT_TRACK,
  SimpleTooltip,
  Skeleton,
  segmentClass,
  X,
} from '../kit';
import { studioKeys } from '../queryKeys';
import { CompareVersionsDialog } from './CompareVersionsDialog';
import { DaySection, RailDot } from './DaySection';

const PAGE = 50;

/** Where the panel remembers being folded, on this computer. */
const FOLDED_KEY = 'runova.studio.historyFolded';

function readFolded(): boolean {
  try {
    return window.localStorage.getItem(FOLDED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeFolded(folded: boolean): void {
  try {
    window.localStorage.setItem(FOLDED_KEY, folded ? '1' : '0');
  } catch {
    // Storage can be unavailable; the panel then just opens unfolded next time.
  }
}

const ACTOR: Record<
  HistoryEntryView['actor'],
  { label: string; tone: 'primary' | 'neutral' | 'success'; dot: string }
> = {
  user: { label: 'You', tone: 'neutral', dot: 'bg-muted-foreground' },
  ai: { label: 'AI', tone: 'primary', dot: 'bg-primary' },
  system: { label: 'Studio', tone: 'success', dot: 'bg-success' },
};

/** Hover shows a row's actions, and so does keyboard focus inside it, so no mouse is needed. */
const ROW_ACTION =
  'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100';

export interface HistoryPanelProps {
  videoId: string;
  currentSeq: number;
  onRestore: (seq: number) => void;
  /** The video's AI runs, for the second tab. */
  ai?: AiRunsListProps;
  /** Opens a video: one started from a version of this one. */
  onOpenVideo?: (videoId: string) => void;
  /** Hides the panel; the History button in the toolbar brings it back. */
  onClose?: () => void;
}

/**
 * Every change ever made to the video, newest first and grouped by day, on a timeline tinted by
 * who made each change. Nothing is ever dropped from it: restoring an older version adds a new
 * entry, so the version restored from is still there to come back to. The panel folds to its
 * header (remembered on this computer) and can be hidden.
 */
export function HistoryPanel({
  videoId,
  currentSeq,
  onRestore,
  ai,
  onOpenVideo,
  onClose,
}: HistoryPanelProps): React.JSX.Element {
  const [tab, setTab] = useState<'changes' | 'ai'>('changes');
  const [folded, setFolded] = useState(readFolded);
  const [compareFrom, setCompareFrom] = useState<number | null>(null);
  const [runs, setRuns] = useState<[string, string] | null>(null);
  const history = useInfiniteQuery({
    queryKey: studioKeys.history(videoId),
    queryFn: ({ pageParam }) => studioClient().history({ videoId, before: pageParam, limit: PAGE }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === PAGE ? last.at(-1)?.seq : undefined),
  });
  const entries = history.data?.pages.flat() ?? [];
  const days = groupByDay(entries, (entry) => entry.at);
  const today = days[0]?.label === 'Today' ? days[0].items.length : 0;
  const summary =
    today > 0
      ? `v${currentSeq}, ${today} ${today === 1 ? 'change' : 'changes'} today`
      : `v${currentSeq}`;

  const fold = () => {
    writeFolded(!folded);
    setFolded(!folded);
  };

  async function restore(entry: HistoryEntryView) {
    const ok = await confirmDialog({
      title: `Go back to version ${entry.seq}?`,
      description: `The video returns to how it was after "${entry.label}". This is added as a new change, so nothing after it is lost.`,
      confirmLabel: 'Restore this version',
    });
    if (ok) onRestore(entry.seq);
  }

  return (
    <aside className={cn(GLASS_PANEL, 'max-h-[calc(100vh-10rem)] self-start')} aria-label="History">
      <div className={cn('flex items-center gap-1.5 px-2 pt-2', folded ? 'pb-2' : 'pb-1')}>
        <button
          type="button"
          aria-expanded={!folded}
          aria-label={folded ? 'Unfold the history' : 'Fold the history'}
          onClick={fold}
          className="group/fold flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-full px-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'h-2.5 w-2.5 shrink-0 text-muted-foreground/60 transition-transform group-hover/fold:text-muted-foreground motion-reduce:transition-none',
              !folded && 'rotate-90',
            )}
          />
          <History aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <h2 className={SECTION_HEADING}>History</h2>
          {folded && (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">{summary}</span>
          )}
        </button>
        {ai && !folded && (
          <div className={SEGMENT_TRACK} role="tablist" aria-label="History view">
            {(
              [
                ['changes', 'Changes'],
                ['ai', 'AI runs'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={segmentClass(tab === id)}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {onClose && (
          <SimpleTooltip label="Hide history">
            <Button variant="ghost" size="icon-xs" aria-label="Hide history" onClick={onClose}>
              <X />
            </Button>
          </SimpleTooltip>
        )}
      </div>
      {folded ? null : ai && tab === 'ai' ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <AiRunsList {...ai} onCompare={setRuns} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {history.isLoading && (
            <div className="space-y-2 p-1" aria-busy="true">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          )}
          {history.error && (
            <LoadFailure
              message={`The history did not load. ${errorMessage(history.error)}`}
              retry={() => void history.refetch()}
            />
          )}
          {days.map((day, index) => (
            <DaySection
              key={day.key}
              label={day.label}
              count={day.items.length}
              defaultOpen={index === 0}
              noun={['change', 'changes']}
            >
              {day.items.map((entry) => {
                const actor = ACTOR[entry.actor];
                const current = entry.seq === currentSeq;
                return (
                  <li
                    key={entry.seq}
                    aria-current={current ? 'true' : undefined}
                    className={cn(
                      'group relative flex items-start gap-2 rounded-lg py-1.5 pl-7 pr-1.5 hover:bg-foreground/[0.04] focus-within:bg-foreground/[0.04]',
                      current && 'bg-primary/[0.06] ring-1 ring-inset ring-primary/15',
                    )}
                  >
                    <RailDot className={actor.dot} />
                    <div className="min-w-0 flex-1">
                      <p
                        className="line-clamp-2 break-words text-xs font-medium"
                        dir="auto"
                        title={entry.label}
                      >
                        {entry.label}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Chip tone={actor.tone}>{actor.label}</Chip>
                        <span>{formatWhen(entry.at)}</span>
                        <span className="tabular-nums">v{entry.seq}</span>
                        {current && <Chip tone="success">Current</Chip>}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {entry.generationId && ai && (
                        <SimpleTooltip label="What the AI was asked">
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label="AI run details"
                            className={ROW_ACTION}
                            onClick={() => ai.onDetails(entry.generationId as string)}
                          >
                            <FileText />
                          </Button>
                        </SimpleTooltip>
                      )}
                      {!current && (
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`Compare version ${entry.seq} with now`}
                          className={ROW_ACTION}
                          onClick={() => setCompareFrom(entry.seq)}
                        >
                          Compare
                        </Button>
                      )}
                      {!current && (
                        <Button
                          size="xs"
                          variant="ghost"
                          className={ROW_ACTION}
                          onClick={() => void restore(entry)}
                        >
                          Restore
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </DaySection>
          ))}
          {history.hasNextPage && (
            <Button
              size="sm"
              variant="ghost"
              className="mt-1 w-full"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              {history.isFetchingNextPage ? 'Loading...' : 'Show older changes'}
            </Button>
          )}
        </div>
      )}
      <CompareVersionsDialog
        videoId={videoId}
        from={compareFrom}
        to={currentSeq}
        onOpenChange={(open) => !open && setCompareFrom(null)}
        onRestore={onRestore}
        onOpenVideo={onOpenVideo}
      />
      <CompareRunsDialog
        videoId={videoId}
        ids={runs}
        onOpenChange={(open) => !open && setRuns(null)}
      />
    </aside>
  );
}
