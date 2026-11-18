import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

export type RunwayTone = 'moving' | 'waiting' | 'paused' | 'done' | 'failed';

const FILL: Record<RunwayTone, string> = {
  moving: 'bg-primary',
  waiting: 'bg-primary',
  paused: 'bg-warning',
  done: 'bg-success',
  failed: 'bg-destructive/60',
};

/**
 * How far a send is, drawn as a runway, Runova's own mark: the centre-line markings run the
 * length of the track, the fill rolls along them with a lit point at its head, and when the last
 * file lands the point flares once and the strip turns green. Waiting for an answer, the track
 * shimmers and gives no number. With reduced motion the fill only steps, and nothing flares.
 */
export function RunwayProgress({
  label,
  value,
  total,
  tone,
  className,
}: {
  label: string;
  value: number;
  total: number;
  tone: RunwayTone;
  className?: string;
}): React.JSX.Element {
  const reduce = useReducedMotion();
  const pct =
    total > 0
      ? Math.max(0, Math.min(100, Math.round((value / total) * 100)))
      : tone === 'done'
        ? 100
        : 0;
  const lit = tone === 'moving' || tone === 'paused';
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(tone === 'waiting' ? {} : { 'aria-valuenow': pct })}
      className={cn(
        'relative h-1.5 rounded-full bg-foreground/[0.07]',
        tone === 'waiting' && 'shimmer overflow-hidden',
        className,
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-1.5 top-1/2 h-px -translate-y-1/2 bg-[repeating-linear-gradient(90deg,hsl(var(--foreground)/0.22)_0_5px,transparent_5px_11px)]"
      />
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none',
          FILL[tone],
        )}
        style={{ width: `${tone === 'waiting' ? 0 : pct}%` }}
      />
      {lit ? (
        <span
          aria-hidden
          className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 transition-[left] duration-500 ease-out motion-reduce:transition-none"
          style={{ left: `${pct}%` }}
        >
          <span
            className={cn(
              'absolute inset-0 rounded-full',
              tone === 'paused'
                ? 'bg-warning shadow-[0_0_10px_2px_hsl(var(--warning)/0.5)]'
                : 'bg-primary shadow-[0_0_10px_2px_hsl(var(--primary)/0.55)]',
            )}
          />
        </span>
      ) : null}
      {tone === 'done' && !reduce ? (
        <span
          aria-hidden
          className="absolute right-0 top-1/2 h-3 w-3 -translate-y-1/2 translate-x-1/2"
        >
          <motion.span
            className="absolute inset-0 rounded-full bg-success"
            initial={{ scale: 0.6, opacity: 0.85 }}
            animate={{ scale: 3.2, opacity: 0 }}
            transition={{ duration: 0.9, ease: 'easeOut' }}
          />
        </span>
      ) : null}
    </div>
  );
}
