import { useId } from 'react';
import { TriangleAlert } from '@/components/icons';
import { SECTION_WELL } from '@/components/pageKit';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/** The small form pieces every tab of the site editor is made of. */

/** A problem with a field, marked with an icon and announced, not only coloured. */
export function FieldError({
  id,
  message,
}: {
  id?: string;
  message?: string;
}): React.JSX.Element | null {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
      <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  disabledReason,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Said under the switch while it is off limits, such as "Needs a certificate first." */
  disabledReason?: string;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className={cn(disabled && 'text-muted-foreground')}>
          {label}
        </Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
        {disabled && disabledReason && (
          <p className="text-xs text-muted-foreground">{disabledReason}</p>
        )}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  placeholder,
  disabled,
  suffix,
  className,
  inputMode,
  mono,
  autoFocus,
  onBlur,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
  /** A unit after the box, such as "seconds". */
  suffix?: string;
  className?: string;
  inputMode?: 'numeric' | 'text' | 'email' | 'url';
  mono?: boolean;
  autoFocus?: boolean;
  onBlur?: () => void;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          autoFocus={autoFocus}
          placeholder={placeholder}
          disabled={disabled}
          inputMode={inputMode}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          className={cn(mono && 'font-mono')}
        />
        {suffix && <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>}
      </div>
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/** A choice between a few options, each a card with a line saying what it does. */
export function ChoiceCards<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  className,
}: {
  /** Read by screen readers as the group's name. */
  label: string;
  options: ReadonlyArray<{ value: T; label: string; description: string }>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}): React.JSX.Element {
  const group = useId();
  return (
    <div role="radiogroup" aria-labelledby={group} className={cn('grid gap-2', className)}>
      <span id={group} className="sr-only">
        {label}
      </span>
      {options.map((option) => {
        const chosen = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={chosen}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              // Inset rings, since a tinted border would lose to the global border colour.
              'cursor-pointer rounded-xl p-3 text-left ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed',
              chosen
                ? 'bg-primary/12 ring-primary/40'
                : 'bg-background/40 ring-foreground/[0.08] hover:bg-foreground/[0.06]',
            )}
          >
            <span className="flex items-center gap-2 text-sm font-medium text-foreground">
              <span
                aria-hidden
                className={cn(
                  'h-3 w-3 shrink-0 rounded-full ring-1 ring-inset',
                  chosen
                    ? 'bg-primary ring-primary shadow-[0_0_8px_hsl(var(--primary)/0.6)]'
                    : 'ring-muted-foreground/60',
                )}
              />
              {option.label}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A titled group of fields inside a tab. */
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn(SECTION_WELL, 'space-y-3 p-4')}>
      <div className="space-y-0.5">
        <h4 id={id} className="text-[13px] font-semibold text-foreground">
          {title}
        </h4>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}
