import { describe, expect, it } from 'vitest';
import { activeSection, frameFor, readingLine, scrollTarget } from '../src/components/help/toc';

const rect = (top: number, left: number, width: number, height: number) =>
  ({ top, left, width, height, right: left + width, bottom: top + height }) as DOMRectReadOnly;

describe('help table of contents', () => {
  it('picks the last heading that has passed the reading line', () => {
    expect(activeSection([-400, -10, 150, 900], 120, false)).toBe(1);
    expect(activeSection([-400, -10, 120, 900], 120, false)).toBe(2);
  });

  it('picks nothing before the first heading', () => {
    expect(activeSection([300, 900], 120, false)).toBe(-1);
    expect(activeSection([], 120, false)).toBe(-1);
  });

  it('picks the last section at the bottom of the page', () => {
    expect(activeSection([-900, -300, 400], 120, true)).toBe(2);
    expect(activeSection([], 120, true)).toBe(-1);
  });

  it('keeps the reading line below the header and above the middle', () => {
    expect(readingLine(300)).toBe(112);
    expect(readingLine(600)).toBe(180);
    expect(readingLine(2000)).toBe(260);
  });

  it('measures the active entry from each side of the track', () => {
    expect(frameFor(rect(100, 20, 200, 600), rect(160, 26, 194, 28))).toEqual({
      top: 60,
      right: 0,
      bottom: 512,
      left: 6,
    });
  });

  it('scrolls the list only when the active entry is out of view', () => {
    expect(scrollTarget(100, 28, 0, 400)).toBeNull();
    expect(scrollTarget(500, 28, 0, 400)).toBe(314);
    expect(scrollTarget(10, 28, 200, 400)).toBe(0);
  });
});
