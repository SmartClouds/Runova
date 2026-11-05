import { describe, expect, it } from 'vitest';
import { throttle } from './throttle';

describe('throttle', () => {
  it('lets the first call through and drops the ones that follow inside the gap', () => {
    let now = 1000;
    const seen: number[] = [];
    const push = throttle(
      (value: number) => seen.push(value),
      200,
      () => now,
    );
    push(1);
    now += 50;
    push(2);
    now += 50;
    push(3);
    expect(seen).toEqual([1]);
  });

  it('lets the next call through once the gap has passed', () => {
    let now = 1000;
    const seen: number[] = [];
    const push = throttle(
      (value: number) => seen.push(value),
      200,
      () => now,
    );
    push(1);
    now += 200;
    push(2);
    now += 199;
    push(3);
    now += 1;
    push(4);
    expect(seen).toEqual([1, 2, 4]);
  });

  it('passes every argument along', () => {
    const seen: [string, number][] = [];
    const push = throttle(
      (a: string, b: number) => seen.push([a, b]),
      10,
      () => 0,
    );
    push('x', 7);
    expect(seen).toEqual([['x', 7]]);
  });
});
