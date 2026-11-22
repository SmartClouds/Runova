import * as React from 'react';
import { CalendarDays, ChevronDown } from '@/components/icons';
import { cn } from '@/lib/utils';
import { Calendar, type Day, parseDay } from './calendar';
import { FIELD_SURFACE } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

const shortDay = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

export interface DatePickerProps {
  /** A `YYYY-MM-DD` day, or an empty string for none. */
  value: Day;
  onChange: (value: Day) => void;
  id?: string;
  'aria-label'?: string;
  placeholder?: string;
  min?: Day | null;
  max?: Day | null;
  today?: Day;
  /** The other end of a range, tinted in the calendar so the span reads at a glance. */
  rangeWith?: Day | null;
  /** Lets the field go back to empty. */
  clearable?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * A day field that opens the app's own calendar, in place of Chromium's native date input
 * whose popup ignores the theme.
 */
export const DatePicker = React.forwardRef<HTMLButtonElement, DatePickerProps>(
  (
    {
      value,
      onChange,
      placeholder = 'Pick a day',
      min,
      max,
      today,
      rangeWith,
      clearable,
      disabled,
      className,
      ...rest
    },
    ref,
  ) => {
    const [open, setOpen] = React.useState(false);
    const ms = parseDay(value);
    const pick = (day: Day) => {
      onChange(day);
      setOpen(false);
    };

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            ref={ref}
            type="button"
            disabled={disabled}
            className={cn(
              FIELD_SURFACE,
              'flex h-9 w-full cursor-pointer items-center gap-2 rounded-full px-3 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50',
              className,
            )}
            {...rest}
          >
            <CalendarDays className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span
              className={cn(
                'flex-1 truncate tabular-nums',
                ms === null && 'text-muted-foreground/70',
              )}
            >
              {ms === null ? placeholder : shortDay.format(ms)}
            </span>
            <ChevronDown
              className={cn(
                'h-2.5 w-2.5 shrink-0 text-muted-foreground transition-transform duration-150',
                open && 'rotate-180',
              )}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-3">
          <Calendar
            selected={value || null}
            rangeWith={rangeWith ?? null}
            min={min ?? null}
            max={max ?? null}
            {...(today ? { today } : {})}
            onSelect={pick}
            {...(clearable ? { onClear: () => pick('') } : {})}
          />
        </PopoverContent>
      </Popover>
    );
  },
);
DatePicker.displayName = 'DatePicker';
