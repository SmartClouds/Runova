import { RefreshCw, X } from '@/components/icons';
import { GLASS_CARD, SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CountUp } from '@/components/usage/CountUp';
import { formatBytes } from '@/lib/format';
import type { CompositionId, CompositionPart } from '@/lib/projectCleanup/selection';
import { shortAge } from '@/lib/time';
import { cn } from '@/lib/utils';

/**
 * The top of the Cleanup tab: the number the person came for, and what the rest of the space is
 * made of. The bar is for a glance and the list under it says the same thing in words and sizes,
 * so the colours are never the only way to read it.
 */

export interface CleanupHeroProps {
  phase: 'scanning' | 'ready';
  /** What could be freed. While scanning, what has been found so far. */
  freeBytes: number;
  totalBytes: number;
  parts: CompositionPart[];
  scannedAt: number | null;
  filesSeen: number;
  /** Which place is being looked through right now. */
  lookingIn: string | null;
  onScan: () => void;
  onCancel: () => void;
}

const SWATCH: Record<CompositionId, string> = {
  own: 'bg-foreground/25',
  git: 'bg-foreground/45',
  dependencies: 'bg-sky-500',
  build: 'bg-amber-500',
  cache: 'bg-violet-500',
  studio: 'bg-emerald-500',
};

function scannedText(scannedAt: number): string {
  const elapsed = Date.now() - scannedAt;
  return elapsed < 10_000 ? 'Scanned just now' : `Scanned ${shortAge(scannedAt)} ago`;
}

export function CleanupHero({
  phase,
  freeBytes,
  totalBytes,
  parts,
  scannedAt,
  filesSeen,
  lookingIn,
  onScan,
  onCancel,
}: CleanupHeroProps): React.JSX.Element {
  const scanning = phase === 'scanning';
  const lean = !scanning && freeBytes <= 0;

  return (
    <section aria-label="Disk use" className={cn(GLASS_CARD, 'flex flex-col gap-4 p-5')}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          {lean ? (
            <p className="text-2xl font-semibold tracking-tight">Nothing to clean up</p>
          ) : scanning && freeBytes <= 0 ? (
            <p className="text-2xl font-semibold tracking-tight">Looking through your project</p>
          ) : (
            <>
              <p className={SECTION_HEADING}>{scanning ? 'Found so far' : 'Can be freed'}</p>
              <p className="text-4xl font-semibold tabular-nums tracking-tight">
                <CountUp value={freeBytes} format={formatBytes} />
              </p>
            </>
          )}
          {scanning ? (
            <p role="status" className="text-sm text-muted-foreground">
              {`${filesSeen.toLocaleString('en-US')} files looked at${lookingIn ? ` in ${lookingIn}` : ''}`}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              This project uses {formatBytes(totalBytes)} in all.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {scanning ? (
            <Button size="sm" variant="soft" onClick={onCancel}>
              <X className="h-3.5 w-3.5" />
              Stop
            </Button>
          ) : (
            <>
              {scannedAt !== null && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {scannedText(scannedAt)}
                </span>
              )}
              <Button size="sm" variant="ghost" onClick={onScan}>
                <RefreshCw className="h-3.5 w-3.5" />
                Scan again
              </Button>
            </>
          )}
        </div>
      </div>

      {scanning ? (
        <Skeleton className="h-2 w-full rounded-full" />
      ) : (
        parts.length > 0 && (
          <>
            <div
              role="img"
              aria-label={`Where the space goes: ${parts
                .map((part) => `${part.label} ${formatBytes(part.bytes)}`)
                .join(', ')}`}
              className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-foreground/[0.07]"
            >
              {parts.map((part) => (
                <span
                  key={part.id}
                  aria-hidden="true"
                  className={cn(
                    'h-full min-w-[3px] basis-0 transition-[flex-grow] duration-500 motion-reduce:transition-none',
                    SWATCH[part.id],
                  )}
                  style={{ flexGrow: part.bytes }}
                />
              ))}
            </div>
            <ul
              aria-label="Space by kind"
              className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted-foreground"
            >
              {parts.map((part) => (
                <li key={part.id} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={cn('size-2 shrink-0 rounded-full', SWATCH[part.id])}
                  />
                  <span>{part.label}</span>
                  <span className="tabular-nums text-foreground">{formatBytes(part.bytes)}</span>
                </li>
              ))}
            </ul>
          </>
        )
      )}
    </section>
  );
}
