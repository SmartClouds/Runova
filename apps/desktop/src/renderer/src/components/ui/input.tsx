import * as React from 'react';
import { ChevronDown, ChevronUp } from '@/components/icons';
import { containsPersian } from '@/lib/rtl';
import { cn } from '@/lib/utils';

/**
 * The shared field look, the same soft pill the search boxes use. The unlayered
 * `.field-surface` rule in index.css draws the wash, the edge, and the hover, focus, invalid,
 * and disabled states, so only shape and size are set here.
 */
export const FIELD_SURFACE = 'field-surface';

/**
 * A native colour input drawn as a small field pill, with Chromium's swatch rounded to match.
 * Callers add the width.
 */
export const COLOR_FIELD = cn(
  FIELD_SURFACE,
  'h-8 w-12 cursor-pointer rounded-full p-1 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-0',
);

/** Height and shape shared by the plain field and the number field's shell. */
const fieldShell = cn(FIELD_SURFACE, 'flex h-9 w-full rounded-full text-sm');

/* Chromium's own spinner is a pair of tiny white arrows that ignore the theme, so number
   fields hide it and draw their own buttons instead (see NumberInput below). */
const hideNativeSpinner =
  '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /**
   * `bare` drops the field surface, for an input that sits inside a container which already
   * draws one (a composer pill, say). Utilities can't strip it, since the rule is unlayered.
   */
  variant?: 'default' | 'bare';
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, value, variant = 'default', ...props }, ref) => {
    const isPersian = typeof value === 'string' && containsPersian(value);
    if (type === 'number') {
      return <NumberInput className={className} value={value} ref={ref} {...props} />;
    }
    return (
      <input
        type={type}
        value={value}
        dir={isPersian ? 'rtl' : undefined}
        ref={ref}
        className={cn(
          variant === 'bare'
            ? 'flex h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70'
            : fieldShell,
          'px-3.5 py-1 disabled:cursor-not-allowed disabled:opacity-50',
          isPersian && 'font-vazirmatn',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

/** How long a held step button waits before it starts repeating, and how often it repeats. */
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 60;

/**
 * A number field whose step buttons are ours: the shell carries the border and any width the
 * caller asked for, the input sits inside it borderless, and the chevrons step the value the
 * way the native arrows would. The buttons fill the pill's rounded right end, split in half, so
 * each one is a real target and its hover lines up with the field's own edge.
 */
const NumberInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, disabled, readOnly, value, min, max, ...props }, ref) => {
    const innerRef = React.useRef<HTMLInputElement | null>(null);
    const setRefs = React.useCallback(
      (node: HTMLInputElement | null) => {
        innerRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    const step = (direction: 'up' | 'down') => {
      const element = innerRef.current;
      if (!element || element.disabled || element.readOnly) return;
      const before = element.value;
      try {
        if (direction === 'up') element.stepUp();
        else element.stepDown();
      } catch {
        // stepUp/stepDown throw on a value the browser cannot parse, nothing to step then.
        return;
      }
      const stepped = element.value;
      // React tracks the last value it wrote, so setting it through the prototype setter is
      // what makes a controlled input notice the change and fire onChange.
      element.value = before;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setValue) setValue.call(element, stepped);
      else element.value = stepped;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.focus();
    };

    const steppable = !disabled && !readOnly;
    // A controlled value at a bound greys out the button that would push past it.
    const current =
      typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
        ? Number(value)
        : Number.NaN;
    const atMax = max !== undefined && Number.isFinite(current) && current >= Number(max);
    const atMin = min !== undefined && Number.isFinite(current) && current <= Number(min);

    return (
      // The shell's `.field-surface` rule dims it while the input inside is disabled, and
      // overflow-hidden clips the step buttons to the pill's round end.
      <div
        className={cn(
          fieldShell,
          'items-stretch overflow-hidden pl-3.5',
          steppable ? 'pr-0' : 'pr-3.5',
          className,
        )}
      >
        <input
          type="number"
          ref={setRefs}
          disabled={disabled}
          readOnly={readOnly}
          value={value}
          min={min}
          max={max}
          className={cn(
            'w-full min-w-0 bg-transparent py-1 outline-none disabled:cursor-not-allowed',
            hideNativeSpinner,
          )}
          {...props}
        />
        {steppable && (
          <span className="ml-1 flex w-6 shrink-0 flex-col border-l border-foreground/[0.08]">
            <StepButton label="Increase value" disabled={atMax} onStep={() => step('up')}>
              <ChevronUp className="h-2.5 w-2.5" />
            </StepButton>
            <StepButton label="Decrease value" disabled={atMin} onStep={() => step('down')}>
              <ChevronDown className="h-2.5 w-2.5" />
            </StepButton>
          </span>
        )}
      </div>
    );
  },
);
NumberInput.displayName = 'NumberInput';

/**
 * One half of the stepper. A press steps once at once, and holding it keeps stepping like the
 * native arrows do, until the pointer comes up anywhere or leaves the button.
 */
function StepButton({
  label,
  disabled,
  onStep,
  children,
}: {
  label: string;
  disabled: boolean;
  onStep: () => void;
  children: React.ReactNode;
}) {
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onStepRef = React.useRef(onStep);
  onStepRef.current = onStep;

  const stop = React.useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('blur', stop);
  }, []);

  React.useEffect(() => stop, [stop]);
  // Reaching the bound mid-hold disables the button, and a disabled button gets no pointerup.
  React.useEffect(() => {
    if (disabled) stop();
  }, [disabled, stop]);

  const start = () => {
    stop();
    onStepRef.current();
    const repeat = () => {
      onStepRef.current();
      timer.current = setTimeout(repeat, REPEAT_EVERY_MS);
    };
    timer.current = setTimeout(repeat, REPEAT_DELAY_MS);
    window.addEventListener('pointerup', stop);
    window.addEventListener('blur', stop);
  };

  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      disabled={disabled}
      // Keeping focus on the field means the value stays selectable and arrow keys keep working.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button === 0) start();
      }}
      onPointerLeave={stop}
      onPointerCancel={stop}
      // A pointer press already stepped; a click with no pointer behind it (detail 0) comes from
      // assistive tech or a script, so it steps here instead.
      onClick={(event) => {
        if (event.detail === 0) onStepRef.current();
      }}
      className="flex min-h-0 flex-1 cursor-pointer items-center justify-center text-muted-foreground transition-colors enabled:hover:bg-foreground/10 enabled:hover:text-foreground enabled:active:bg-foreground/[0.16] disabled:cursor-default disabled:text-muted-foreground/35"
    >
      {children}
    </button>
  );
}

export { Input };
