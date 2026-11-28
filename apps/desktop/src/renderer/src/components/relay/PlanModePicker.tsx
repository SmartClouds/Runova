import type { RelayPlanModeChoice } from '@shared/relayTypes';
import { cn } from '@/lib/utils';

const MODES: { value: RelayPlanModeChoice; label: string; hint: string }[] = [
  {
    value: 'fit',
    label: 'Fit the context budget',
    hint: 'Tasks sized to the context one AI session holds.',
  },
  {
    value: 'plan',
    label: 'Plan only',
    hint: 'Parts sized by what they deliver, each with a full spec, and no context budget. Run them now or later, with any agent.',
  },
];

/**
 * How a request is split (E121): into tasks that fit a context budget, or into parts of a plan
 * that have nothing to do with context, each specced so it can be built on its own later.
 */
export function PlanModePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: RelayPlanModeChoice;
  onChange: (next: RelayPlanModeChoice) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const hint = MODES.find((mode) => mode.value === value)?.hint ?? '';
  return (
    <div className="space-y-1.5">
      <div
        role="radiogroup"
        aria-label="How to split"
        className="field-surface inline-flex h-8 items-stretch gap-0.5 rounded-full p-0.5"
      >
        {MODES.map((mode) => {
          const selected = value === mode.value;
          return (
            <button
              key={mode.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(mode.value)}
              className={cn(
                'cursor-pointer rounded-full px-3 text-xs transition-colors disabled:pointer-events-none',
                selected
                  ? 'bg-primary/15 font-medium text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)]'
                  : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
              )}
            >
              {mode.label}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
    </div>
  );
}
