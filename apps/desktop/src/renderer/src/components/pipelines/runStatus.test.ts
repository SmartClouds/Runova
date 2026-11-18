import { describe, expect, it } from 'vitest';
import { approxDuration, formatMs, runDuration, spanDuration } from './runStatus';

describe('spanDuration', () => {
  it('reads seconds, minutes and hours the way GitHub does', () => {
    expect(spanDuration('2026-03-15T09:00:00Z', '2026-03-15T09:00:45Z')).toBe('45s');
    expect(spanDuration('2026-03-15T09:00:00Z', '2026-03-15T09:01:05Z')).toBe('1m 5s');
    expect(spanDuration('2026-03-15T09:00:00Z', '2026-03-15T11:02:30Z')).toBe('2h 2m');
  });

  it('shows a step that took no time as 0s instead of hiding it', () => {
    expect(spanDuration('2026-03-15T09:00:00Z', '2026-03-15T09:00:00Z')).toBe('0s');
    expect(spanDuration('2026-03-15T09:00:00.000Z', '2026-03-15T09:00:00.400Z')).toBe('0s');
  });

  it('is empty when a time is missing, so a step that has not started shows nothing', () => {
    expect(spanDuration(null, '2026-03-15T09:00:45Z')).toBe('');
    expect(spanDuration('2026-03-15T09:00:00Z', null)).toBe('');
    expect(spanDuration(undefined, undefined)).toBe('');
  });

  it('is empty for a reversed or unreadable pair', () => {
    expect(spanDuration('2026-03-15T09:01:00Z', '2026-03-15T09:00:00Z')).toBe('');
    expect(spanDuration('not a date', '2026-03-15T09:00:00Z')).toBe('');
  });

  it('counts up to the given clock while the end is still open', () => {
    const now = Date.parse('2026-03-15T09:02:03Z');
    expect(spanDuration('2026-03-15T09:00:00Z', null, now)).toBe('2m 3s');
    // A finished span ignores the clock.
    expect(spanDuration('2026-03-15T09:00:00Z', '2026-03-15T09:00:10Z', now)).toBe('10s');
  });
});

describe('runDuration', () => {
  it('still measures from created to updated', () => {
    expect(
      runDuration({ createdAt: '2026-03-15T09:00:00Z', updatedAt: '2026-03-15T09:04:12Z' }),
    ).toBe('4m 12s');
    expect(runDuration({ createdAt: 'nope', updatedAt: '2026-03-15T09:04:12Z' })).toBe('');
  });
});

describe('formatMs', () => {
  it('reads a length of time the way spanDuration does', () => {
    expect(formatMs(45_000)).toBe('45s');
    expect(formatMs(65_400)).toBe('1m 5s');
    expect(formatMs(7_350_000)).toBe('2h 2m');
  });

  it('shows nothing for a length that makes no sense', () => {
    expect(formatMs(-1)).toBe('');
    expect(formatMs(Number.NaN)).toBe('');
  });
});

describe('approxDuration', () => {
  it('rounds short times to five seconds, never below five', () => {
    expect(approxDuration(2_400)).toBe('5s');
    expect(approxDuration(43_000)).toBe('45s');
    expect(approxDuration(47_400)).toBe('45s');
  });

  it('rounds a few minutes to ten seconds', () => {
    expect(approxDuration(58_000)).toBe('1m');
    expect(approxDuration(130_000)).toBe('2m 10s');
    expect(approxDuration(134_000)).toBe('2m 10s');
  });

  it('rounds longer times to the minute, and hours to five minutes', () => {
    expect(approxDuration(600_000)).toBe('10m');
    expect(approxDuration(864_000)).toBe('14m');
    expect(approxDuration(3_900_000)).toBe('1h 5m');
    expect(approxDuration(7_200_000)).toBe('2h');
  });
});
