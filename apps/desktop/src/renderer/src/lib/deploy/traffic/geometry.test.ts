import { describe, expect, it } from 'vitest';
import {
  areaPath,
  breakdownRows,
  donutSegments,
  hourOfWeekRows,
  linePath,
  niceMax,
  shadeStep,
  stackColumns,
} from './geometry';

describe('niceMax', () => {
  it('rounds the top of the axis up to a clean number', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(0.4)).toBe(0.5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(12)).toBe(20);
    expect(niceMax(230)).toBe(250);
    expect(niceMax(4100)).toBe(5000);
    expect(niceMax(1000)).toBe(1000);
  });
});

describe('linePath and areaPath', () => {
  it('spreads the values over the width and scales them to the height', () => {
    expect(linePath([0, 5, 10], 100, 50, 10)).toBe('M0 50 L50 25 L100 0');
    expect(linePath([4], 100, 50, 10)).toBe('M100 30');
    expect(linePath([], 100, 50, 10)).toBe('');
  });

  it('leaves a gap where a value is missing', () => {
    expect(linePath([null, null, 5, 10], 90, 50, 10)).toBe('M60 25 L90 0');
    expect(linePath([2, null, 4], 100, 50, 10)).toBe('M0 40 M100 30');
    expect(linePath([null], 100, 50, 10)).toBe('');
  });

  it('closes the area along the bottom', () => {
    expect(areaPath([0, 10], 100, 50, 10)).toBe('M0 50 L100 0 L100 50 L0 50 Z');
    expect(areaPath([], 100, 50, 10)).toBe('');
  });

  it('keeps values above the top inside the plot', () => {
    expect(linePath([20], 100, 50, 10)).toBe('M100 0');
  });
});

describe('breakdownRows', () => {
  it('gives each value its share of the total and a bar against the largest', () => {
    const rows = breakdownRows(
      [
        { value: '/', count: 600 },
        { value: '/pricing', count: 300 },
        { value: '/tiny', count: 1 },
      ],
      1000,
    );
    expect(rows.map((row) => [row.value, row.share, row.bar])).toEqual([
      ['/', 0.6, 100],
      ['/pricing', 0.3, 50],
      ['/tiny', 0.001, 2],
    ]);
  });

  it('copes with an empty total', () => {
    expect(breakdownRows([{ value: 'x', count: 0 }], 0)).toEqual([
      { value: 'x', count: 0, share: 0, bar: 2 },
    ]);
  });
});

describe('donutSegments', () => {
  it('draws one arc a value, leaving out zeros, with shares that add up', () => {
    const segments = donutSegments([60, 30, 0, 10], 50, 34);
    expect(segments.map((segment) => [segment.index, segment.share])).toEqual([
      [0, 0.6],
      [1, 0.3],
      [3, 0.1],
    ]);
    expect(segments[0].d).toMatch(/^M[\d.-]+ [\d.-]+A50 50 0 1 1 /);
    expect(segments[1].d).toMatch(/A50 50 0 0 1 /);
  });

  it('draws a whole ring for a single value and nothing for none', () => {
    const [ring] = donutSegments([5], 50, 34);
    expect(ring.share).toBe(1);
    expect(ring.d.match(/A50/g)).toHaveLength(2);
    expect(donutSegments([0, 0], 50, 34)).toEqual([]);
  });
});

describe('shadeStep', () => {
  it('puts a count on a five-step scale that grows with the log', () => {
    expect(shadeStep(0, 1000)).toBe(0);
    expect(shadeStep(1, 1000)).toBe(1);
    expect(shadeStep(1000, 1000)).toBe(5);
    expect(shadeStep(30, 1000)).toBe(3);
    expect(shadeStep(5, 0)).toBe(0);
  });
});

describe('hourOfWeekRows', () => {
  it('cuts 168 hours into seven named days, Monday first', () => {
    const values = Array.from({ length: 168 }, (_, i) => i);
    const rows = hourOfWeekRows(values);
    expect(rows.map((row) => row.day)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(rows[1].hours[0]).toBe(24);
    expect(rows[6].hours[23]).toBe(167);
  });

  it('fills a short list with zeros', () => {
    expect(
      hourOfWeekRows([3])
        .flatMap((row) => row.hours)
        .slice(0, 2),
    ).toEqual([3, 0]);
  });
});

describe('stackColumns', () => {
  it('stacks each column from the baseline, leaving a gap between parts', () => {
    const columns = stackColumns(
      [
        [6, 4],
        [0, 2],
      ],
      { height: 100, max: 10, gap: 2 },
    );
    expect(columns[0]).toEqual([
      { index: 0, y: 40, height: 60 },
      { index: 1, y: 0, height: 38 },
    ]);
    expect(columns[1]).toEqual([{ index: 1, y: 80, height: 20 }]);
  });
});
