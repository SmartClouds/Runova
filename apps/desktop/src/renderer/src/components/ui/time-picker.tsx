import * as React from 'react';
import { ChevronDown, Clock } from '@/components/icons';
import {
  formatTime,
  from12,
  type HourCycle,
  minuteOptions,
  type Period,
  pad2,
  parseTime,
  systemHourCycle,
  to12,
  toTimeValue,
} from '@/lib/timeOfDay';
import { cn } from '@/lib/utils';
import { FIELD_SURFACE } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

const HOURS_12 = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const HOURS_24 = Array.from({ length: 24 }, (_, hour) => hour);
const PERIODS: Period[] = ['AM', 'PM'];

export interface TimePickerProps {
  /** An `HH:MM` time on a 24-hour clock, the same value a native time input holds. */
  value: string;
  onChange: (value: string) => void;
  id?: string;
  'aria-label'?: string;
  placeholder?: string;
  /** How the time reads and which hours are listed. Defaults to this machine's clock setting. */
  hourCycle?: HourCycle;
  /** The gap between listed minutes. A saved minute between two steps is still listed. */
  minuteStep?: number;
  disabled?: boolean;
  className?: string;
}

interface ColumnOption<T> {
  value: T;
  label: string;
}

/**
 * One scrolling column of the picker. It is a listbox with a roving tab stop, so Tab moves
 * between columns and the arrow keys move within one. The picked option is kept centred.
 */
function Column<T>({
  label,
  options,
  selected,
  onPick,
  onDone,
  short,
}: {
  label: string;
  options: ColumnOption<T>[];
  selected: T;
  onPick: (value: T) => void;
  onDone: () => void;
  /** A column with only a couple of options, which sits centred instead of scrolling. */
  short?: boolean;
}): React.JSX.Element {
  const listRef = React.useRef<HTMLDivElement>(null);
  const mounted = React.useRef(false);
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === selected),
  );

  React.useLayoutEffect(() => {
    const list = listRef.current;
    const option = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !option) return;
    if (list.contains(document.activeElement) && document.activeElement !== option) {
      option.focus({ preventScroll: true });
    }
    if (!short) {
      const top = option.offsetTop - (list.clientHeight - option.offsetHeight) / 2;
      if (mounted.current && typeof list.scrollTo === 'function') {
        list.scrollTo({ top, behavior: 'smooth' });
      } else {
        list.scrollTop = top;
      }
    }
    mounted.current = true;
  });

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const last = options.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else if (event.key === 'Enter') {
      event.preventDefault();
      onDone();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    const option = options[next];
    if (option) onPick(option.value);
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cn(
        // Wide enough that the picked chip's glow is not clipped by the scrolling column.
        'relative flex w-16 flex-col items-center gap-1 outline-none',
        short
          ? 'justify-center'
          : 'h-44 overflow-y-auto overscroll-contain py-[4.5rem] [mask-image:linear-gradient(to_bottom,transparent,black_22%,black_78%,transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
      )}
    >
      {options.map((option, position) => {
        const isSelected = position === index;
        return (
          <button
            key={option.label}
            type="button"
            role="option"
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onPick(option.value)}
            className={cn(
              'flex h-8 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-sm tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isSelected
                ? 'bg-primary font-semibold text-primary-foreground shadow-[0_0_14px_-4px_hsl(var(--primary)/0.8)]'
                : 'text-foreground/80 hover:bg-foreground/10 hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A time of day field that opens the app's own hour and minute columns, in place of
 * Chromium's native time input whose popup ignores the theme.
 */
export const TimePicker = React.forwardRef<HTMLButtonElement, TimePickerProps>(
  (
    {
      value,
      onChange,
      placeholder = 'Pick a time',
      hourCycle,
      minuteStep = 5,
      disabled,
      className,
      ...rest
    },
    ref,
  ) => {
    const [open, setOpen] = React.useState(false);
    const cycle = hourCycle ?? systemHourCycle();
    const parts = parseTime(value);
    const hour = parts?.hour ?? 0;
    const minute = parts?.minute ?? 0;
    const { hour12, period } = to12(hour);
    const set = (nextHour: number, nextMinute: number) =>
      onChange(toTimeValue(nextHour, nextMinute));
    const close = () => setOpen(false);

    const hourColumn =
      cycle === 12 ? (
        <Column
          label="Hour"
          options={HOURS_12.map((h) => ({ value: h, label: String(h) }))}
          selected={hour12}
          onPick={(h) => set(from12(h, period), minute)}
          onDone={close}
        />
      ) : (
        <Column
          label="Hour"
          options={HOURS_24.map((h) => ({ value: h, label: pad2(h) }))}
          selected={hour}
          onPick={(h) => set(h, minute)}
          onDone={close}
        />
      );

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            ref={ref}
            type="button"
            disabled={disabled}
            className={cn(
              FIELD_SURFACE,
              'inline-flex h-9 cursor-pointer items-center gap-2 rounded-full pl-3 pr-2.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50',
              className,
            )}
            {...rest}
          >
            <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span
              className={cn(
                'flex-1 whitespace-nowrap tabular-nums',
                parts === null && 'text-muted-foreground/70',
              )}
            >
              {parts === null ? placeholder : formatTime(value, cycle)}
            </span>
            <ChevronDown
              className={cn(
                'h-2.5 w-2.5 shrink-0 text-muted-foreground transition-transform duration-150',
                open && 'rotate-180',
              )}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto select-none p-3">
          <div className="mb-2 flex items-baseline justify-center gap-1.5 tabular-nums">
            <span className="text-2xl font-semibold tracking-tight">
              {cycle === 12 ? `${hour12}:${pad2(minute)}` : toTimeValue(hour, minute)}
            </span>
            {cycle === 12 ? (
              <span className="text-xs font-medium text-muted-foreground">{period}</span>
            ) : null}
          </div>
          <div className="flex items-stretch gap-1 rounded-xl bg-foreground/[0.03] px-1 ring-1 ring-inset ring-foreground/[0.06]">
            {hourColumn}
            <span
              aria-hidden
              className="flex items-center text-base font-semibold text-muted-foreground/60"
            >
              :
            </span>
            <Column
              label="Minute"
              options={minuteOptions(minuteStep, minute).map((m) => ({
                value: m,
                label: pad2(m),
              }))}
              selected={minute}
              onPick={(m) => set(hour, m)}
              onDone={close}
            />
            {cycle === 12 ? (
              <>
                <span aria-hidden className="my-3 w-px bg-foreground/10" />
                <Column
                  label="AM or PM"
                  short
                  options={PERIODS.map((p) => ({ value: p, label: p }))}
                  selected={period}
                  onPick={(p) => set(from12(hour12, p), minute)}
                  onDone={close}
                />
              </>
            ) : null}
          </div>
          <div className="mt-2 flex justify-end border-t border-foreground/10 pt-2">
            <button
              type="button"
              className="cursor-pointer rounded-full px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/12"
              onClick={close}
            >
              Done
            </button>
          </div>
        </PopoverContent>
      </Popover>
    );
  },
);
TimePicker.displayName = 'TimePicker';
