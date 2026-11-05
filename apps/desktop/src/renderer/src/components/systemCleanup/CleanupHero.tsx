import { Broom, CircleCheck, RefreshCw, X } from '@/components/icons';
import { Chip, GLASS_CARD, PillTabs, SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { CountUp } from '@/components/usage/CountUp';
import { formatBytes } from '@/lib/format';
import type { Overview } from '@/lib/systemCleanup/view';
import { shortAge } from '@/lib/time';
import { cn } from '@/lib/utils';

/**
 * The top of the page: the one number the person came for, and what the rest of the space is made
 * of. It changes with what is going on, in four phases: an invitation before the first scan, a
 * live count while scanning, the answer once it is done, and a progress card while cleaning.
 * The bar is for a glance and the key beside it says the same thing in words and sizes, so the
 * colours are never the only way to read it.
 */

export type HeroPhase = 'empty' | 'scanning' | 'ready' | 'cleaning';

export interface CleanupHeroProps {
  phase: HeroPhase;
  overview: Overview;
  /** How many versions of each package a clean-up keeps. */
  keep: number;
  /** How far a scan has got, while scanning. */
  scan: { done: number; total: number; bytes: number; files: number } | null;
  /** How far a clean-up has got, while cleaning. */
  clean: { label: string | null; processed: number; total: number; freedBytes: number } | null;
  /** For "from your last scan, 2d ago", so a test can fix the clock. */
  now?: number;
  onKeepChange: (keep: number) => void;
  onScan: () => void;
  onCancel: () => void;
  onCleanOld: () => void;
}

/** Colours for the parts of the bar. Literal classes, as the project clean-up draws its own. */
const SWATCH = [
  'bg-sky-500',
  'bg-amber-500',
  'bg-violet-500',
  'bg-emerald-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-foreground/30',
];

const KEEP_CHOICES = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
];

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

function Progress({
  label,
  value,
  max,
}: {
  label: string;
  value: number;
  max: number;
}): React.JSX.Element {
  const fraction = max <= 0 ? 0 : Math.min(1, value / max);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="h-2 w-full overflow-hidden rounded-full bg-foreground/[0.08]"
    >
      <div
        className="bar-shine h-full origin-left rounded-full bg-primary transition-transform duration-300 motion-reduce:transition-none"
        style={{ transform: `scaleX(${Math.max(0.03, fraction)})` }}
      />
    </div>
  );
}

function GlowTile({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-[0_0_40px_-12px_hsl(var(--primary)/0.7)]">
      {children}
    </div>
  );
}

function SpaceBar({ overview }: { overview: Overview }): React.JSX.Element | null {
  const { parts } = overview;
  if (parts.length === 0) return null;
  return (
    <>
      <div
        role="img"
        aria-label={`Where the space goes: ${parts
          .map((part) => `${part.label} ${formatBytes(part.bytes)}`)
          .join(', ')}`}
        className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-foreground/[0.07]"
      >
        {parts.map((part, index) => (
          <span
            key={part.id}
            aria-hidden="true"
            className={cn(
              'h-full min-w-[3px] basis-0 transition-[flex-grow] duration-500 motion-reduce:transition-none',
              SWATCH[index % SWATCH.length],
            )}
            style={{ flexGrow: part.bytes }}
          />
        ))}
      </div>
      <ul
        aria-label="Space by cache"
        className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted-foreground"
      >
        {parts.map((part, index) => (
          <li key={part.id} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn('size-2 shrink-0 rounded-full', SWATCH[index % SWATCH.length])}
            />
            <span>{part.label}</span>
            <span className="tabular-nums text-foreground">{formatBytes(part.bytes)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function DiskLine({ volume }: { volume: NonNullable<Overview['volume']> }): React.JSX.Element {
  const total = Math.max(1, volume.totalBytes);
  const cache = Math.min(100, (volume.cacheBytes / total) * 100);
  const used = Math.max(0, volume.totalBytes - volume.freeBytes - volume.cacheBytes);
  const other = Math.min(100 - cache, (used / total) * 100);
  return (
    <div className="space-y-1.5">
      <div
        aria-hidden="true"
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.07]"
      >
        <span className="h-full bg-foreground/25" style={{ width: `${other}%` }} />
        <span className="h-full bg-primary" style={{ width: `${Math.max(cache, 0.5)}%` }} />
      </div>
      <p className="text-xs tabular-nums text-muted-foreground">
        Caches use {formatBytes(volume.cacheBytes)} of the {formatBytes(volume.totalBytes)} on{' '}
        {volume.mount}, and {formatBytes(volume.freeBytes)} is free.
      </p>
    </div>
  );
}

export function CleanupHero(props: CleanupHeroProps): React.JSX.Element {
  const { phase, overview, keep, scan, clean, now = Date.now() } = props;

  if (phase === 'empty') {
    return (
      <section
        aria-label="Disk use"
        className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-4 p-5')}
      >
        <GlowTile>
          <Broom className="h-5 w-5" />
        </GlowTile>
        <div className="min-w-0 flex-1 basis-72 space-y-1">
          <p className="text-2xl font-semibold tracking-tight">See what your tools are keeping</p>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            Package managers and developer tools save downloads on your disk and rarely clear them
            out. Disk Cleanup finds those caches, shows what each one takes, and removes old
            versions or everything. Nothing in your projects is touched.
          </p>
        </div>
        <Button onClick={props.onScan}>
          <RefreshCw />
          Find caches
        </Button>
      </section>
    );
  }

  if (phase === 'scanning' && scan) {
    return (
      <section aria-label="Disk use" className={cn(GLASS_CARD, 'flex flex-col gap-4 p-5')}>
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-2xl font-semibold tracking-tight">Looking through your caches</p>
            <p role="status" className="text-sm text-muted-foreground">
              {scan.done} of {scan.total} caches read
            </p>
          </div>
          <Button size="sm" variant="soft" onClick={props.onCancel}>
            <X />
            Stop
          </Button>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <CountUp
            value={scan.bytes}
            format={formatBytes}
            className="text-4xl font-semibold tabular-nums tracking-tight"
          />
          <span className="text-sm text-muted-foreground">found so far</span>
          <span className="text-sm tabular-nums text-muted-foreground">
            {plural(scan.files, 'file')}
          </span>
        </div>
        <Progress label="Scanning caches" value={scan.done} max={scan.total} />
      </section>
    );
  }

  if (phase === 'cleaning' && clean) {
    return (
      <section aria-label="Disk use" className={cn(GLASS_CARD, 'flex flex-col gap-4 p-5')}>
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-2xl font-semibold tracking-tight">
              Cleaning {clean.label ?? 'caches'}
            </p>
            <p role="status" className="text-sm tabular-nums text-muted-foreground">
              {clean.processed} of {clean.total}
            </p>
          </div>
          <Button size="sm" variant="soft" onClick={props.onCancel}>
            <X />
            Cancel
          </Button>
        </div>
        <div className="space-y-1">
          <p className={SECTION_HEADING}>Freed so far</p>
          <CountUp
            value={clean.freedBytes}
            format={formatBytes}
            className="text-4xl font-semibold tabular-nums tracking-tight"
          />
        </div>
        <Progress label="Cleaning" value={clean.processed} max={clean.total} />
      </section>
    );
  }

  const nothing = overview.cachesFound === 0;
  const tidy = !nothing && overview.reclaimableBytes <= 0;
  const keepText = keep === 1 ? 'version' : `${keep} versions`;

  return (
    <section aria-label="Disk use" className={cn(GLASS_CARD, 'flex flex-col gap-4 p-5')}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          {nothing ? (
            <>
              <p className="text-2xl font-semibold tracking-tight">Nothing found</p>
              <p className="text-sm text-muted-foreground">
                No package caches were found on this machine.
              </p>
            </>
          ) : tidy ? (
            <>
              <p className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
                <CircleCheck className="h-6 w-6 text-success" />
                Everything is tidy
              </p>
              <p className="text-sm text-muted-foreground">
                Only the newest versions are left. You can still clear a whole cache below.
              </p>
            </>
          ) : (
            <>
              <p className={SECTION_HEADING}>Can be freed</p>
              <p className="text-4xl font-semibold tabular-nums tracking-tight">
                <CountUp value={overview.reclaimableBytes} format={formatBytes} />
              </p>
              <p className="text-sm text-muted-foreground">
                Free it by removing all but the newest {keepText} of each package.
              </p>
            </>
          )}
          {!nothing && (
            <p className="text-sm tabular-nums text-muted-foreground">
              {formatBytes(overview.totalBytes)} in {plural(overview.cachesFound, 'cache')}
              {overview.packageCount > 0 && <>, {plural(overview.packageCount, 'package')}</>}.
            </p>
          )}
          {overview.remembered && overview.scannedAt !== null && (
            <Chip>From your last scan, {shortAge(overview.scannedAt, now)} ago</Chip>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!nothing && !tidy && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Keep newest</span>
              <PillTabs
                id="cleanup-keep"
                label="Versions to keep"
                kind="toggle"
                size="xs"
                items={KEEP_CHOICES}
                value={String(keep)}
                onChange={(value) => props.onKeepChange(Number(value))}
              />
            </div>
          )}
          <Button size="sm" variant="ghost" onClick={props.onScan}>
            <RefreshCw />
            Scan again
          </Button>
          {!nothing && !tidy && (
            <Button size="sm" onClick={props.onCleanOld}>
              <Broom />
              Clean old versions
            </Button>
          )}
        </div>
      </div>

      <SpaceBar overview={overview} />
      {overview.volume && <DiskLine volume={overview.volume} />}
    </section>
  );
}
