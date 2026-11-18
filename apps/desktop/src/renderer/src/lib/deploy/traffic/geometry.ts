import type { TrafficCount } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * The traffic report's chart geometry (E109), kept out of the components so it is worked out once
 * per report (the components memoise it) and tested on its own. Every chart is hand-drawn SVG with
 * no chart library, following the dataviz rules: one axis, thin marks, a 2px gap between parts.
 */

/** The shortest a bar is drawn, so a value with a tiny share still shows a mark. */
export const MIN_BAR_PERCENT = 2;
const NICE_STEPS = [1, 2, 2.5, 5, 10];

/** The top of an axis: the largest value rounded up to 1, 2, 2.5 or 5 times a power of ten. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const normalized = max / magnitude;
  const step = NICE_STEPS.find((candidate) => candidate >= normalized - 1e-9) ?? 10;
  return Number((step * magnitude).toPrecision(12));
}

function round(value: number): number {
  return Number(value.toFixed(1));
}

function points(values: readonly number[], width: number, height: number, max: number) {
  const top = max > 0 ? max : 1;
  const n = values.length;
  return values.map((value, index) => {
    const x = n <= 1 ? width : (index / (n - 1)) * width;
    const y = height * (1 - Math.min(1, Math.max(0, value / top)));
    return [round(x), round(y)] as const;
  });
}

/** A line through the values, spread evenly over the width; a missing value leaves a gap. */
export function linePath(
  values: readonly (number | null)[],
  width: number,
  height: number,
  max: number,
): string {
  const at = points(
    values.map((value) => value ?? 0),
    width,
    height,
    max,
  );
  let gap = true;
  const parts: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      gap = true;
      return;
    }
    parts.push(`${gap ? 'M' : 'L'}${at[index][0]} ${at[index][1]}`);
    gap = false;
  });
  return parts.join(' ');
}

/** The same line closed along the bottom, for the 10% wash under it. */
export function areaPath(
  values: readonly number[],
  width: number,
  height: number,
  max: number,
): string {
  if (values.length === 0) return '';
  const at = points(values, width, height, max);
  const first = at[0][0];
  const last = at[at.length - 1][0];
  return `${linePath(values, width, height, max)} L${last} ${height} L${first} ${height} Z`;
}

export interface BreakdownRow extends TrafficCount {
  /** Of the breakdown's total, 0 to 1. */
  share: number;
  /** The bar's length in percent of the largest value. */
  bar: number;
}

export function breakdownRows(top: readonly TrafficCount[], total: number): BreakdownRow[] {
  const largest = Math.max(0, ...top.map((item) => item.count));
  return top.map((item) => ({
    value: item.value,
    count: item.count,
    share: total > 0 ? item.count / total : 0,
    bar:
      largest > 0
        ? Math.max(MIN_BAR_PERCENT, Math.round((item.count / largest) * 100))
        : MIN_BAR_PERCENT,
  }));
}

export interface DonutSegment {
  /** Which value it draws, so its colour follows the value and not its rank. */
  index: number;
  share: number;
  d: string;
}

/** The space left between two arcs, in radians: about 2px on the ring the report draws. */
const DONUT_GAP = 0.035;

function polar(r: number, angle: number): string {
  return `${round(r * Math.cos(angle))} ${round(r * Math.sin(angle))}`;
}

/** Arcs of a ring centred on 0,0, clockwise from the top, one for each value above zero. */
export function donutSegments(values: readonly number[], r: number, inner: number): DonutSegment[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return [];
  const drawn = values.filter((value) => value > 0).length;
  const segments: DonutSegment[] = [];
  let angle = -Math.PI / 2;
  values.forEach((value, index) => {
    if (value <= 0) return;
    const share = value / total;
    if (drawn === 1) {
      segments.push({
        index,
        share: 1,
        d: `M0 ${-r}A${r} ${r} 0 1 1 0 ${r}A${r} ${r} 0 1 1 0 ${-r}ZM0 ${-inner}A${inner} ${inner} 0 1 0 0 ${inner}A${inner} ${inner} 0 1 0 0 ${-inner}Z`,
      });
      return;
    }
    const sweep = share * Math.PI * 2;
    const start = angle + DONUT_GAP / 2;
    const end = angle + sweep - DONUT_GAP / 2;
    const large = end - start > Math.PI ? 1 : 0;
    segments.push({
      index,
      share,
      d: `M${polar(r, start)}A${r} ${r} 0 ${large} 1 ${polar(r, end)}L${polar(inner, end)}A${inner} ${inner} 0 ${large} 0 ${polar(inner, start)}Z`,
    });
    angle += sweep;
  });
  return segments;
}

/** A count on a scale of `steps` shades (0 for none) that grows with the log, so one big country does not wash out the rest. */
export function shadeStep(value: number, max: number, steps = 5): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(steps, Math.max(1, Math.ceil((steps * Math.log1p(value)) / Math.log1p(max))));
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The core's 168 hours (Monday 00:00 first) as seven rows of 24. */
export function hourOfWeekRows(values: readonly number[]): Array<{ day: string; hours: number[] }> {
  return DAYS.map((day, row) => ({
    day,
    hours: Array.from({ length: 24 }, (_, hour) => values[row * 24 + hour] ?? 0),
  }));
}

export interface StackPart {
  /** Which part of the stack, so its colour follows the series. */
  index: number;
  y: number;
  height: number;
}

/**
 * Each column's parts stacked up from the baseline, the first at the bottom, with `gap` of surface
 * between one part and the next. A part with nothing in it is left out.
 */
export function stackColumns(
  columns: readonly (readonly number[])[],
  { height, max, gap }: { height: number; max: number; gap: number },
): StackPart[][] {
  const top = max > 0 ? max : 1;
  return columns.map((parts) => {
    const drawn: StackPart[] = [];
    let base = height;
    parts.forEach((value, index) => {
      if (!(value > 0)) return;
      const raw = (value / top) * height;
      const bottom = drawn.length > 0 ? base - gap : base;
      const y = Math.max(0, base - raw);
      const size = bottom - y;
      base = y;
      if (size > 0) drawn.push({ index, y: round(y), height: round(size) });
    });
    return drawn;
  });
}
