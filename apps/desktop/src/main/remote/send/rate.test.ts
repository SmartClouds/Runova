import { describe, expect, it } from 'vitest';
import { RateMeter } from './rate';

describe('a transfer rate', () => {
  it('knows nothing until a second sample comes in', () => {
    let now = 0;
    const meter = new RateMeter(() => now);
    meter.update(0);

    expect(meter.bytesPerSecond()).toBeNull();
    expect(meter.secondsLeft(1_000)).toBeNull();

    now = 1_000;
    meter.update(10_000);
    expect(meter.bytesPerSecond()).toBe(10_000);
    expect(meter.secondsLeft(50_000)).toBe(5);
  });

  it('smooths a sudden change instead of jumping to it', () => {
    let now = 0;
    const meter = new RateMeter(() => now);
    meter.update(0);
    for (let second = 1; second <= 10; second++) {
      now = second * 1_000;
      meter.update(second * 10_000);
    }

    now = 11_000;
    meter.update(10 * 10_000 + 100_000);

    const rate = meter.bytesPerSecond() ?? 0;
    expect(rate).toBeGreaterThan(10_000);
    expect(rate).toBeLessThan(100_000);
  });

  it('ignores samples too close together to mean anything', () => {
    let now = 0;
    const meter = new RateMeter(() => now);
    meter.update(0);
    now = 1_000;
    meter.update(10_000);

    now = 1_010;
    meter.update(1_000_000);

    expect(meter.bytesPerSecond()).toBe(10_000);
  });

  it('starts over after a pause, so the time spent reconnecting is not counted as slow', () => {
    let now = 0;
    const meter = new RateMeter(() => now);
    meter.update(0);
    now = 1_000;
    meter.update(10_000);

    meter.reset();
    now = 60_000;
    meter.update(10_000);
    now = 61_000;
    meter.update(30_000);

    expect(meter.bytesPerSecond()).toBe(20_000);
  });
});
