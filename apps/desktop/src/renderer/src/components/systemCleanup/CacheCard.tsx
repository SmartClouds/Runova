import { Check, CircleInfo, FolderOpen, RefreshCw, Trash2 } from '@/components/icons';
import { Chip, GLASS_CARD } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import type { CardModel } from '@/lib/systemCleanup/view';
import { shortAge } from '@/lib/time';
import { cn } from '@/lib/utils';
import { ProviderMark } from './ProviderMark';

/**
 * One cache: what it is, how big it is, where it lives, and what can be done to it. The size is
 * the thing the eye should land on; the chips say the state in words (so colour is never the
 * only signal); the buttons are named for the cache they act on, so a screen reader hears
 * "Clear all of NuGet" and not just "Clear all".
 */

export interface CacheCardProps {
  card: CardModel;
  /** The size of the biggest cache on the page, which the bar under the size is drawn against. */
  biggest: number;
  /** A scan or a clean-up is running, so nothing new can be started. */
  busy: boolean;
  /** For "scanned 3d ago", so a test can fix the clock. */
  now?: number;
  onReview: () => void;
  onCleanOld: () => void;
  onClearAll: () => void;
  onTool: (kind: 'tidy' | 'clear-command') => void;
  onScan: () => void;
  onReveal: () => void;
}

const TOOL_TEXT = { tidy: 'Remove unused', 'clear-command': 'Clear cache' } as const;

function filesText(card: CardModel): string {
  const files = `${card.files.toLocaleString('en-US')} ${card.files === 1 ? 'file' : 'files'}`;
  if (card.state === 'scanning') return `${files} so far`;
  if (card.packageCount > 0) {
    const packages = `${card.packageCount.toLocaleString('en-US')} ${card.packageCount === 1 ? 'package' : 'packages'}`;
    return `${packages}, ${files}`;
  }
  return files;
}

function StateChips({ card, now }: { card: CardModel; now: number }): React.JSX.Element | null {
  const chips: React.ReactNode[] = [];
  if (card.state === 'unverified') {
    chips.push(
      <Chip key="state" tone="warning">
        Not recognised
      </Chip>,
    );
  } else if (card.state === 'error') {
    chips.push(
      <Chip key="state" tone="destructive">
        Could not read
      </Chip>,
    );
  } else if (card.state === 'live' || card.state === 'remembered') {
    if (card.kind === 'opaque') {
      chips.push(<Chip key="state">Cleaned by {card.label}</Chip>);
    } else if (card.bytes <= 0) {
      chips.push(<Chip key="state">Empty</Chip>);
    } else if (card.reclaimableBytes > 0) {
      chips.push(
        <Chip key="state" tone="primary">
          Can free {formatBytes(card.reclaimableBytes)}
        </Chip>,
      );
    } else {
      chips.push(
        <Chip key="state" tone="success">
          <Check />
          Tidy
        </Chip>,
      );
    }
    if (card.state === 'remembered' && card.scannedAt !== null) {
      chips.push(<Chip key="age">Scanned {shortAge(card.scannedAt, now)} ago</Chip>);
    }
  }
  if (chips.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-1.5">{chips}</div>;
}

export function CacheCard({
  card,
  biggest,
  busy,
  now = Date.now(),
  onReview,
  onCleanOld,
  onClearAll,
  onTool,
  onScan,
  onReveal,
}: CacheCardProps): React.JSX.Element {
  const waiting = card.state === 'queued';
  const reading = card.state === 'scanning';
  const settled = !waiting && !reading;
  const share = biggest > 0 ? Math.round((card.bytes / biggest) * 100) : 0;
  const { actions } = card;
  const anyAction = actions.review || actions.cleanOld || actions.clearAll || actions.tool !== null;

  return (
    <section
      aria-label={`${card.label} cache`}
      className={cn(GLASS_CARD, 'flex min-w-0 flex-col gap-3 p-4')}
    >
      <header className="flex items-start gap-3">
        <ProviderMark id={card.id} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{card.label}</h3>
          <p className="truncate text-xs text-muted-foreground">{card.tagline}</p>
        </div>
        {settled && (
          <SimpleTooltip label="Read it again">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Scan ${card.label} again`}
              disabled={busy}
              onClick={onScan}
            >
              <RefreshCw />
            </Button>
          </SimpleTooltip>
        )}
      </header>

      <div className="space-y-1.5">
        {waiting ? (
          <>
            <Skeleton className="h-7 w-24" />
            <p className="text-xs text-muted-foreground">Waiting for its turn</p>
          </>
        ) : (
          <>
            <p className="text-2xl font-semibold tabular-nums tracking-tight">
              {formatBytes(card.bytes)}
            </p>
            <p className="text-xs tabular-nums text-muted-foreground">
              {reading ? <>Reading, {filesText(card)}</> : filesText(card)}
            </p>
          </>
        )}
        <div
          aria-hidden="true"
          className="h-1 w-full overflow-hidden rounded-full bg-foreground/[0.07]"
        >
          {reading ? (
            <div className="h-full w-1/3 rounded-full bg-primary/70 motion-safe:animate-pulse" />
          ) : (
            <div
              data-testid="size-bar"
              className="h-full rounded-full bg-primary/70 transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${Math.max(2, share)}%` }}
            />
          )}
        </div>
      </div>

      <StateChips card={card} now={now} />

      {card.note && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <CircleInfo className="mt-px h-3 w-3 shrink-0" />
          <span>{card.note}</span>
        </p>
      )}

      {card.root && (
        <div className="flex min-w-0 items-center gap-1">
          <SimpleTooltip label={card.root}>
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
              {card.root}
            </code>
          </SimpleTooltip>
          <CopyButton text={card.root} label="Copy path" alwaysVisible />
          <SimpleTooltip label="Show in folder">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Show ${card.label} in its folder`}
              onClick={onReveal}
            >
              <FolderOpen />
            </Button>
          </SimpleTooltip>
        </div>
      )}

      {settled && anyAction && (
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          {actions.review && (
            <Button
              size="sm"
              variant="soft"
              aria-label={`Review ${card.label}`}
              disabled={busy}
              onClick={onReview}
            >
              Review
            </Button>
          )}
          {actions.cleanOld && (
            <Button
              size="sm"
              variant="tint"
              aria-label={`Clean old versions in ${card.label}`}
              disabled={busy}
              onClick={onCleanOld}
            >
              Clean old versions
            </Button>
          )}
          {actions.tool && (
            <SimpleTooltip label={`Runs ${actions.tool.label}`}>
              <Button
                size="sm"
                variant="tint"
                aria-label={`${TOOL_TEXT[actions.tool.kind]} (${card.label})`}
                disabled={busy}
                onClick={() => actions.tool && onTool(actions.tool.kind)}
              >
                {TOOL_TEXT[actions.tool.kind]}
              </Button>
            </SimpleTooltip>
          )}
          {actions.clearAll && (
            <Button
              size="sm"
              variant="danger"
              aria-label={`Clear all of ${card.label}`}
              disabled={busy}
              onClick={onClearAll}
            >
              <Trash2 />
              Clear all
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
