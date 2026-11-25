/** Helpers for an `HH:MM` time of day, the value a time field holds. */

export type HourCycle = 12 | 24;
export type Period = 'AM' | 'PM';

export interface TimeParts {
  hour: number;
  minute: number;
}

const TIME = /^(\d{2}):(\d{2})$/;

export function parseTime(value: string): TimeParts | null {
  const match = TIME.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function toTimeValue(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

export function to12(hour: number): { hour12: number; period: Period } {
  return { hour12: hour % 12 === 0 ? 12 : hour % 12, period: hour < 12 ? 'AM' : 'PM' };
}

export function from12(hour12: number, period: Period): number {
  return (hour12 % 12) + (period === 'PM' ? 12 : 0);
}

/** `3:00 AM` on a 12-hour clock, `03:00` on a 24-hour one, or empty for no time. */
export function formatTime(value: string, cycle: HourCycle): string {
  const parts = parseTime(value);
  if (!parts) return '';
  if (cycle === 24) return toTimeValue(parts.hour, parts.minute);
  const { hour12, period } = to12(parts.hour);
  return `${hour12}:${pad2(parts.minute)} ${period}`;
}

/** Every `step` minutes of the hour, plus `current` when it falls between two steps. */
export function minuteOptions(step: number, current: number): number[] {
  const minutes: number[] = [];
  for (let minute = 0; minute < 60; minute += step) minutes.push(minute);
  if (!minutes.includes(current)) {
    minutes.push(current);
    minutes.sort((a, b) => a - b);
  }
  return minutes;
}

/** Whether this machine's locale reads the clock in 12 or 24 hours. */
export function systemHourCycle(): HourCycle {
  const { hourCycle } = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions();
  return hourCycle === 'h11' || hourCycle === 'h12' ? 12 : 24;
}
