import { describe, expect, it } from 'vitest';
import {
  formatTime,
  from12,
  minuteOptions,
  parseTime,
  systemHourCycle,
  to12,
  toTimeValue,
} from './timeOfDay';

describe('parseTime', () => {
  it('reads an HH:MM value', () => {
    expect(parseTime('04:15')).toEqual({ hour: 4, minute: 15 });
    expect(parseTime('23:59')).toEqual({ hour: 23, minute: 59 });
  });

  it('turns down anything that is not a time of day', () => {
    expect(parseTime('')).toBeNull();
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('12:60')).toBeNull();
    expect(parseTime('7:5')).toBeNull();
    expect(parseTime('ab:cd')).toBeNull();
  });
});

describe('toTimeValue', () => {
  it('pads both parts to two digits', () => {
    expect(toTimeValue(4, 5)).toBe('04:05');
    expect(toTimeValue(22, 45)).toBe('22:45');
  });
});

describe('to12 and from12', () => {
  it('maps midnight and noon to 12', () => {
    expect(to12(0)).toEqual({ hour12: 12, period: 'AM' });
    expect(to12(12)).toEqual({ hour12: 12, period: 'PM' });
    expect(to12(15)).toEqual({ hour12: 3, period: 'PM' });
    expect(to12(9)).toEqual({ hour12: 9, period: 'AM' });
  });

  it('goes back to a 24-hour hour', () => {
    expect(from12(12, 'AM')).toBe(0);
    expect(from12(12, 'PM')).toBe(12);
    expect(from12(10, 'PM')).toBe(22);
    expect(from12(3, 'AM')).toBe(3);
  });
});

describe('formatTime', () => {
  it('writes the time the way the clock setting reads', () => {
    expect(formatTime('03:00', 12)).toBe('3:00 AM');
    expect(formatTime('22:30', 12)).toBe('10:30 PM');
    expect(formatTime('00:05', 12)).toBe('12:05 AM');
    expect(formatTime('03:00', 24)).toBe('03:00');
    expect(formatTime('22:30', 24)).toBe('22:30');
  });

  it('leaves an unreadable value empty', () => {
    expect(formatTime('', 12)).toBe('');
  });
});

describe('minuteOptions', () => {
  it('steps through the hour', () => {
    expect(minuteOptions(15, 0)).toEqual([0, 15, 30, 45]);
    expect(minuteOptions(5, 10)).toHaveLength(12);
  });

  it('keeps a minute that falls between the steps, in order', () => {
    expect(minuteOptions(15, 7)).toEqual([0, 7, 15, 30, 45]);
  });
});

describe('systemHourCycle', () => {
  it('is either a 12-hour or a 24-hour clock', () => {
    expect([12, 24]).toContain(systemHourCycle());
  });
});
