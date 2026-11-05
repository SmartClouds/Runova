import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, Check, ChevronDown, Copy, TerminalSquare } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { RunLog } from '@/stores/applyVersionLogStore';

/** Within this many pixels of the bottom counts as reading the latest, so new lines follow. */
const STICK_DISTANCE_PX = 24;

/** `42s`, `3m 07s`: short enough for a header strip, steady enough to read while it ticks. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** How a line reads: a step the CLI took, a command it ran, a failure, or what it said. */
function LogLine({ line }: { line: string }): React.JSX.Element {
  const marker = line.slice(0, 2);
  if (marker === '› ' || marker === '$ ') {
    return (
      <div className="text-white/85">
        <span className={marker === '$ ' ? 'text-amber-300' : 'text-emerald-400'}>
          {marker.trim()}
        </span>{' '}
        {line.slice(2)}
      </div>
    );
  }
  if (marker === '✗ ') {
    return <div className="text-red-400">{line}</div>;
  }
  return <div className="text-white/55">{line}</div>;
}

/**
 * A read-only terminal view of what a background CLI run is doing, for runs that take minutes
 * and would otherwise be a spinner the user just has to trust. Nothing here can be typed into:
 * the run has no terminal, and the panel only shows the steps the CLI reports.
 *
 * While `live`, it follows new lines as long as the user is at the bottom and holds still once
 * they scroll up to read, with a button back to the latest. Once the run is over it folds into a
 * "Run log" row that opens the same view again.
 */
export function RunLogPanel({
  log,
  live,
}: {
  log: RunLog | undefined;
  live: boolean;
}): React.JSX.Element | null {
  const lines = log?.lines ?? [];
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [behind, setBehind] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const box = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const open = live || expanded;

  // The elapsed time only moves while the run does.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new line, or opening the view, is the trigger; the effect reads neither
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    if (following.current) element.scrollTop = element.scrollHeight;
    else setBehind(true);
  }, [lines.length, open]);

  function jumpToLatest(): void {
    const element = box.current;
    if (!element) return;
    following.current = true;
    setBehind(false);
    element.scrollTop = element.scrollHeight;
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      toast.success('Run log copied.');
    } catch {
      toast.error('Could not copy. Select the text and copy it by hand.');
    }
  }

  if (!live && lines.length === 0) return null;

  const count = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
  const elapsed = log ? formatElapsed(now - log.startedAt) : null;

  const header = (
    <div className="flex items-center gap-2 px-3 py-1.5">
      {live ? (
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
        </span>
      ) : (
        <TerminalSquare aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      {live ? (
        <span className="text-xs font-medium text-foreground">Live output</span>
      ) : (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 items-center gap-1.5 rounded-md text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Run log
          <ChevronDown
            aria-hidden
            className={cn(
              'h-3 w-3 text-muted-foreground transition-transform',
              expanded && 'rotate-180',
            )}
          />
        </button>
      )}
      <span className="text-[11px] tabular-nums text-muted-foreground">
        {live && elapsed ? `${elapsed} · ${count}` : count}
      </span>
      <SimpleTooltip label={copied ? 'Copied' : 'Copy the log'}>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto h-6 w-6 shrink-0"
          aria-label="Copy run log"
          disabled={lines.length === 0}
          onClick={() => void copy()}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </Button>
      </SimpleTooltip>
    </div>
  );

  return (
    <section
      aria-label="Run log"
      className={cn(
        'overflow-hidden',
        // Live, it is the foot of the running card; afterwards it stands on its own.
        live ? 'border-t border-border/70' : 'rounded-xl border border-border bg-card/60',
      )}
    >
      {header}
      {open && (
        <div className="relative">
          <div
            ref={box}
            role="log"
            aria-label="Run output"
            aria-live="off"
            aria-readonly
            tabIndex={0}
            onScroll={(event) => {
              const element = event.currentTarget;
              following.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < STICK_DISTANCE_PX;
              if (following.current) setBehind(false);
            }}
            className={cn(
              'terminal-well overflow-y-auto overscroll-contain px-3 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap select-text',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              // A fixed height while live, so the dialog doesn't grow under the pointer.
              live ? 'h-44' : 'max-h-64',
            )}
          >
            {log && log.dropped > 0 && (
              <div className="text-white/40">
                … {log.dropped} earlier line{log.dropped === 1 ? '' : 's'} not shown
              </div>
            )}
            {lines.length === 0 ? (
              <div className="text-white/55">Starting your CLI…</div>
            ) : (
              lines.map((line, index) => (
                // Lines only ever append, so the index is a stable key.
                <LogLine key={index} line={line} />
              ))
            )}
            {live && (
              <span
                aria-hidden
                className="inline-block h-3 w-1.5 translate-y-0.5 bg-emerald-400/80 motion-safe:animate-pulse"
              />
            )}
          </div>
          {behind && (
            <Button
              variant="soft"
              size="sm"
              className="absolute right-3 bottom-2 h-6 gap-1 px-2 text-[11px] shadow-sm"
              onClick={jumpToLatest}
            >
              <ArrowDown className="h-3 w-3" /> Latest
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
