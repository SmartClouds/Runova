import { cn } from '@/lib/utils';

export type ProgressTone = 'primary' | 'success' | 'danger' | 'muted';

const FILL: Record<ProgressTone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  danger: 'bg-destructive',
  muted: 'bg-muted-foreground/40',
};

const HEIGHT = { sm: 'h-1', md: 'h-1.5' } as const;

/**
 * A thin progress bar. With `value` null it doesn't know how far along it is yet and a streak
 * runs along it instead. `marks` draws faint notches where the work moves from one step to the
 * next, and `live` sweeps a soft light over the fill while the work is under way. Motion stops
 * for anyone who asked their system for less of it (the sweeps live in index.css).
 */
export function ProgressBar({
  value,
  label,
  valueText,
  tone = 'primary',
  size = 'sm',
  marks,
  live = false,
  className,
}: {
  value: number | null;
  /** The bar's accessible name. */
  label: string;
  /** What a screen reader says for the value, when the number alone says too little. */
  valueText?: string;
  tone?: ProgressTone;
  size?: keyof typeof HEIGHT;
  marks?: readonly number[];
  live?: boolean;
  className?: string;
}): React.JSX.Element {
  const percent = value === null ? null : Math.round(Math.max(0, Math.min(100, value)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-valuetext={valueText}
      data-tone={tone}
      data-indeterminate={percent === null ? 'true' : undefined}
      className={cn(
        'relative w-full overflow-hidden rounded-full bg-foreground/[0.08]',
        HEIGHT[size],
        percent === null && 'browser-progress',
        className,
      )}
    >
      {percent !== null ? (
        <div
          className={cn(
            'h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none',
            FILL[tone],
            live && 'relative overflow-hidden eta-sheen',
          )}
          style={{ width: `${percent}%` }}
        />
      ) : null}
      {marks?.map((mark) => (
        <span
          key={mark}
          aria-hidden
          data-mark
          className="absolute inset-y-0 w-px -translate-x-1/2 bg-background/80"
          style={{ left: `${mark}%` }}
        />
      ))}
    </div>
  );
}
