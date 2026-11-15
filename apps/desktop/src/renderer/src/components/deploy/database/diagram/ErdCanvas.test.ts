import { describe, expect, it } from 'vitest';
import { clampZoom, revealView, zoomAt } from './ErdCanvas';

/** The view arithmetic behind zooming and bringing a picked table into sight. */

describe('zoomAt', () => {
  it('keeps the point under the pointer where it was', () => {
    const view = zoomAt({ x: 0, y: 0, zoom: 1 }, 2, { x: 100, y: 50 });
    expect(view).toEqual({ x: -100, y: -50, zoom: 2 });
  });

  it('stays within the zoom limits', () => {
    expect(clampZoom(5)).toBe(2);
    expect(clampZoom(0.01)).toBe(0.2);
  });
});

describe('revealView', () => {
  const visible = { width: 600, height: 400 };

  it('leaves the view alone when the card is already in sight', () => {
    const view = { x: 0, y: 0, zoom: 1 };
    expect(revealView(view, { x: 100, y: 100, width: 200, height: 100 }, visible)).toBe(view);
  });

  it('slides left just enough to show a card behind the right edge', () => {
    const view = revealView(
      { x: 0, y: 0, zoom: 1 },
      { x: 500, y: 100, width: 200, height: 100 },
      visible,
    );
    expect(view).toEqual({ x: -124, y: 0, zoom: 1 });
  });

  it('slides the other way for a card off the top left, at any zoom', () => {
    const view = revealView(
      { x: 0, y: 0, zoom: 0.5 },
      { x: -100, y: -200, width: 200, height: 100 },
      visible,
    );
    expect(view).toEqual({ x: 74, y: 124, zoom: 0.5 });
  });
});
