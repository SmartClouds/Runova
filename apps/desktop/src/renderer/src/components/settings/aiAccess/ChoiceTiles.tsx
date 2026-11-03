import type { ReactNode } from 'react';
import type { Robot } from '@/components/icons';
import { cn } from '@/lib/utils';

/**
 * A row of large choice tiles for one setting, in the style of the agent tab view picker: an icon,
 * a label, a line on what it means, and room for a small preview or example underneath.
 */

export interface ChoiceTile<Value extends string> {
  value: Value;
  label: string;
  hint: string;
  icon: typeof Robot;
  /** A small badge beside the label, like "Recommended". */
  badge?: string;
  /** Extra content under the hint: an example, a preview. */
  extra?: ReactNode;
  /** Draws the chosen tile in the warning colour, for a choice that lowers protection. */
  caution?: boolean;
}

export function ChoiceTiles<Value extends string>({
  label,
  description,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  description?: string;
  options: ChoiceTile<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  className?: string;
}): React.JSX.Element {
  return (
    <div className="space-y-2.5">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div role="group" aria-label={label} className={cn('grid gap-2', className)}>
        {options.map((option) => {
          const active = value === option.value;
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => {
                if (!active) onChange(option.value);
              }}
              className={cn(
                'flex cursor-pointer flex-col rounded-lg border p-3 text-left transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active && option.caution
                  ? 'border-warning/50 bg-warning/10 ring-1 ring-warning/40'
                  : active
                    ? 'border-primary/50 bg-primary/10 ring-1 ring-primary/40'
                    : 'border-border bg-background/40 hover:border-foreground/20 hover:bg-accent/40',
              )}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon
                  className={cn(
                    'h-3.5 w-3.5',
                    active
                      ? option.caution
                        ? 'text-warning'
                        : 'text-primary'
                      : 'text-muted-foreground',
                  )}
                />
                <span className="min-w-0 flex-1">{option.label}</span>
                {option.badge ? (
                  <span className="rounded-full bg-primary/12 px-1.5 py-px text-[10px] font-medium text-primary">
                    {option.badge}
                  </span>
                ) : null}
              </span>
              <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {option.hint}
              </span>
              {option.extra}
            </button>
          );
        })}
      </div>
    </div>
  );
}
