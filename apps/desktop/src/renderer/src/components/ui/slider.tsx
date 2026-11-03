import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A native range input drawn with the app's `.settings-range` look (index.css): the track fills
 * in the primary colour up to the value. Being a real range input, arrow keys, Page Up and Down,
 * Home and End all work, and screen readers read it as a slider.
 */

export interface SliderProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'type' | 'value' | 'onChange' | 'min' | 'max' | 'step'
  > {
  value: number;
  min: number;
  max: number;
  step?: number;
  onValueChange: (value: number) => void;
  /** The value in words, such as "50%" or "2 of 8 cores", for screen readers. */
  valueLabel?: string;
}

export const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ value, min, max, step = 1, onValueChange, valueLabel, className, style, ...props }, ref) => {
    const span = max - min;
    const pct = span > 0 ? Math.min(100, Math.max(0, ((value - min) / span) * 100)) : 0;
    return (
      <input
        ref={ref}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={valueLabel}
        onChange={(event) => onValueChange(Number(event.target.value))}
        className={cn('settings-range', className)}
        style={{ ...style, ['--range-pct' as string]: `${pct}%` }}
        {...props}
      />
    );
  },
);
Slider.displayName = 'Slider';
