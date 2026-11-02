import { motion, useReducedMotion } from 'framer-motion';
import { FOOTER_HAIRLINE, SectionCard } from '@/components/pageKit';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** Form pieces the Cloudflare page shares, in the look of the app's own inputs. */

export function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * The kit's notice and card under the names the Cloudflare page has always used. A Cloudflare
 * card is flush: its parts pad themselves, so tables and hairline rows can run edge to edge.
 */
export {
  Notice,
  type NoticeTone,
  Problem,
  SectionCardBody as CardBody,
} from '@/components/pageKit';

export function CloudflareCard({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SectionCard>, 'flush' | 'bodyClassName'>): React.JSX.Element {
  return (
    <SectionCard flush className={cn('flex min-w-0 flex-col', className)} {...props}>
      {children}
    </SectionCard>
  );
}

/**
 * One setting in a settings card: its name and what it does on the left, the control on the
 * right, and room underneath for a notice about the current value.
 */
export function SettingRow({
  title,
  titleId,
  htmlFor,
  description,
  children,
  below,
}: {
  title: string;
  /** Names the control by the title, for a switch or a group that has no label element. */
  titleId?: string;
  /** Points the title at an input, for a combobox. */
  htmlFor?: string;
  description: string;
  children: React.ReactNode;
  below?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {htmlFor ? (
            <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
              {title}
            </label>
          ) : (
            <p id={titleId} className="text-sm font-medium text-foreground">
              {title}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      </div>
      {below}
    </div>
  );
}

/** The rows of a settings card while they load. */
export function SettingsSkeleton({ rows = 4 }: { rows?: number }): React.JSX.Element {
  return (
    <div className={cn(FOOTER_HAIRLINE, 'settings-rows')} aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3.5">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <Skeleton className="h-8 w-40 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * A short row of exclusive choices drawn as a sliding pill, for a setting with two to four values
 * that all fit on one line. Picking the current one does nothing.
 */
export function SegmentedChoice<T extends string>({
  labelledBy,
  layoutId,
  options,
  value,
  disabled,
  onChange,
}: {
  /** The id of the title that names the group. */
  labelledBy: string;
  /** Unique on the page, so the pill slides only within its own group. */
  layoutId: string;
  options: readonly { value: T; label: string }[];
  value: T;
  disabled: boolean;
  onChange: (next: T) => void;
}): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="inline-flex flex-wrap items-center gap-0.5 rounded-full bg-foreground/[0.06] p-0.5"
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => {
              if (!active) onChange(option.value);
            }}
            className={cn(
              'relative h-7 cursor-pointer rounded-full px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
              active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                aria-hidden
                layoutId={layoutId}
                transition={
                  reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 32 }
                }
                className="absolute inset-0 rounded-full bg-background shadow-sm ring-1 ring-inset ring-primary/25"
              />
            )}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
