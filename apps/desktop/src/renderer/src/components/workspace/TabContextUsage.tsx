import { useId } from 'react';
import { ChevronRight } from '@/components/icons';
import { FuelRing } from '@/components/relay/FuelRing';
import { cn } from '@/lib/utils';
import {
  type ContextLevel,
  contextHotTokens,
  contextLeftLabel,
  contextLevel,
  contextPercentLabel,
  contextUsedLabel,
} from '@/lib/workspace/contextUsage';
import { useLiveContextUsage } from '@/stores/contextUsageStore';
import { useUiStore } from '@/stores/uiStore';

const PERCENT_TONE: Record<ContextLevel, string> = {
  calm: 'text-foreground',
  warm: 'text-warning',
  hot: 'text-destructive',
};

/** The same colours as the ring beside the label, so the two read as one meter. */
const BAR_TONE: Record<ContextLevel, string> = {
  calm: 'bg-emerald-500',
  warm: 'bg-amber-500',
  hot: 'bg-rose-500',
};

/** Before any reading the ring is drawn against the standard window, empty. */
const FALLBACK_WINDOW = 200_000;

function stopHere(event: React.SyntheticEvent): void {
  event.stopPropagation();
}

/**
 * The context section at the bottom of a Claude Code tab's hover card. Closed, it peeks at how
 * full the window is; open, it adds a bar and the token counts. Open or closed is one choice for
 * every tab, kept across restarts. It reads the session while it is mounted, which is exactly as
 * long as the card is showing, so the numbers are fresh every time it is looked at.
 */
export function TabContextUsage({ sessionId }: { sessionId: string }): React.JSX.Element {
  const usage = useLiveContextUsage(sessionId);
  const open = useUiStore((s) => s.tabContextOpen);
  const setOpen = useUiStore((s) => s.setTabContextOpen);
  const bodyId = useId();
  const level = usage ? contextLevel(usage) : null;
  // A sliver of use still shows on the bar, and a context past its window never overflows it.
  const barWidth = usage
    ? Math.min(100, Math.max(usage.tokens > 0 ? 1.5 : 0, (usage.tokens / usage.window) * 100))
    : 0;

  return (
    <div
      data-context-usage=""
      data-level={level ?? 'unknown'}
      className="-mx-2.5 mt-1.5 min-w-[14rem] border-t border-foreground/10 px-1.5 pt-1"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        // The card is a tooltip on the tab: taking focus would blur the tab and close it, and a
        // click left to bubble would reach the tab strip through the React tree.
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDown={stopHere}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden className="inline-flex">
          <FuelRing
            used={usage?.tokens ?? null}
            budget={usage?.window ?? FALLBACK_WINDOW}
            guardAt={usage ? contextHotTokens(usage) : null}
            size={14}
            tick={false}
          />
        </span>
        <span className="min-w-0 flex-1">Context window</span>
        {usage === undefined ? (
          <span
            aria-hidden
            data-testid="context-loading"
            className="h-2 w-7 animate-pulse rounded-full bg-foreground/10 motion-reduce:animate-none"
          />
        ) : usage && level ? (
          <span className={cn('font-semibold tabular-nums', PERCENT_TONE[level])}>
            {contextPercentLabel(usage)}
          </span>
        ) : null}
        <ChevronRight
          className={cn(
            'h-2.5 w-2.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
      </button>
      {open ? (
        <div
          id={bodyId}
          className="px-1 pb-1 pt-1 duration-200 animate-in fade-in-0 slide-in-from-top-1 motion-reduce:animate-none"
        >
          {usage && level ? (
            <>
              <div
                aria-hidden
                className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10"
              >
                <div
                  data-testid="context-bar"
                  style={{ width: `${barWidth}%` }}
                  className={cn(
                    'h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none',
                    BAR_TONE[level],
                  )}
                />
              </div>
              <p className="mt-1.5 tabular-nums">{contextUsedLabel(usage)}</p>
              <p className="tabular-nums text-muted-foreground">{contextLeftLabel(usage)}</p>
            </>
          ) : usage === null ? (
            <p className="text-muted-foreground">Appears once Claude replies</p>
          ) : (
            <div
              aria-hidden
              className="h-1.5 w-full animate-pulse rounded-full bg-foreground/10 motion-reduce:animate-none"
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
