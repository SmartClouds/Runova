import { Checkbox } from '@/components/ui/checkbox';

export interface OverBudgetValue {
  keepRolling: boolean;
  runPastBudget: boolean;
}

const OPTIONS: { key: keyof OverBudgetValue; label: string; hint: string }[] = [
  {
    key: 'keepRolling',
    label: 'Keep handing off',
    hint: 'A task bigger than the budget is not split to fit. Each session hands off near the budget and a fresh one carries on, with no limit on sessions.',
  },
  {
    key: 'runPastBudget',
    label: 'Run past the budget',
    hint: 'Sessions are never told to hand off for their context. The CLI compacts its own context and the handoff is written when the session stops.',
  },
];

/**
 * What happens to a task that is bigger than its context budget. Both are off by default: tasks
 * are split to fit, and a task that needs too many sessions pauses the relay. Two sessions in a row
 * that leave the same handoff pause it in every mode.
 */
export function OverBudgetOptions({
  value,
  onChange,
  disabled = false,
}: {
  value: OverBudgetValue;
  onChange: (next: OverBudgetValue) => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="mb-1.5 text-xs text-muted-foreground">
        When a task is bigger than the budget
      </legend>
      {OPTIONS.map((option) => {
        const id = `relay-over-budget-${option.key}`;
        return (
          <div key={option.key} className="flex items-start gap-2.5">
            <Checkbox
              id={id}
              className="mt-0.5"
              checked={value[option.key]}
              disabled={disabled}
              onCheckedChange={(checked) => onChange({ ...value, [option.key]: checked === true })}
            />
            <label htmlFor={id} className="min-w-0 cursor-pointer">
              <span className="block text-xs font-medium">{option.label}</span>
              <span className="block text-[11px] leading-snug text-muted-foreground">
                {option.hint}
              </span>
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}
