import { describe, expect, it } from 'vitest';
import {
  canvasPixels,
  FALL_MS,
  hslTripletToRgb,
  LAND_MS,
  LIGHT_MS,
  landing,
  lighting,
  runLength,
  tipY,
} from '../src/components/effects/beam';

describe('hero beam helpers', () => {
  it('turns the --glow triplet into RGB', () => {
    const [r, g, b] = hslTripletToRgb('150 100% 45%');
    expect(r).toBeCloseTo(0, 3);
    expect(g).toBeCloseTo(0.9, 3);
    expect(b).toBeCloseTo(0.45, 3);
    expect(hslTripletToRgb('0 0% 100%')).toEqual([1, 1, 1]);
  });

  it('falls back to the Dark glow green for a value it cannot read', () => {
    expect(hslTripletToRgb('')).toEqual([0, 0.9, 0.45]);
  });

  it('caps the pixel ratio at 1.5', () => {
    expect(canvasPixels(800, 600, 3)).toEqual({ width: 1200, height: 900, scale: 1.5 });
    expect(canvasPixels(800, 600, 1)).toEqual({ width: 800, height: 600, scale: 1 });
  });

  it('keeps the long side within 2000 device pixels', () => {
    const big = canvasPixels(2560, 1400, 2);
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(2000);
    expect(big.width / big.height).toBeCloseTo(2560 / 1400, 2);
  });

  it('lights the source up first', () => {
    expect(lighting(0)).toBe(0);
    expect(lighting(LIGHT_MS)).toBe(1);
  });

  it('drops the tip from the source onto the window once the source is lit, faster as it goes', () => {
    expect(tipY(0, 40, 600)).toBe(40);
    expect(tipY(LIGHT_MS, 40, 600)).toBe(40);
    expect(tipY(LIGHT_MS + FALL_MS, 40, 600)).toBe(600);
    expect(tipY(LIGHT_MS + FALL_MS * 3, 40, 600)).toBe(600);
    const half = LIGHT_MS + FALL_MS / 2;
    const firstHalf = tipY(half, 40, 600) - 40;
    const secondHalf = 600 - tipY(half, 40, 600);
    expect(secondHalf).toBeGreaterThan(firstHalf);
  });

  it('spreads the light only after the tip lands', () => {
    const landed = LIGHT_MS + FALL_MS;
    expect(landing(landed)).toBe(0);
    expect(landing(landed + LAND_MS / 2)).toBeGreaterThan(0.5);
    expect(landing(landed + LAND_MS)).toBe(1);
  });

  it('lets the poured light flow fast at first, then slow down short of its full length', () => {
    const landed = LIGHT_MS + FALL_MS;
    expect(runLength(landed, 1000)).toBe(0);
    const first = runLength(landed + 1000, 1000);
    const second = runLength(landed + 2000, 1000) - first;
    expect(first).toBeGreaterThan(second);
    expect(runLength(landed + 10_000, 1000)).toBeLessThanOrEqual(1000);
    expect(runLength(landed + 10_000, 1000)).toBeGreaterThan(990);
  });
});
