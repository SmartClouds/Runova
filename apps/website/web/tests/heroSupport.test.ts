import { describe, expect, it, vi } from 'vitest';
import {
  afterFirstPaint,
  FRAME_INTERVAL_MS,
  frameDue,
  type HeroEnvironment,
  heroFallbackReason,
  scenePixelRatio,
  tokenToHsl,
} from '../src/lib/heroSupport';

const capable: HeroEnvironment = {
  reducedMotion: false,
  webgl: true,
  cores: 8,
  memoryGb: 8,
  saveData: false,
};

describe('heroFallbackReason', () => {
  it('runs the scene on a capable device', () => {
    expect(heroFallbackReason(capable)).toBeNull();
  });

  it('keeps the static image under reduced motion, before anything else', () => {
    expect(heroFallbackReason({ ...capable, reducedMotion: true, webgl: false })).toBe(
      'reduced-motion',
    );
  });

  it('keeps the static image without WebGL', () => {
    expect(heroFallbackReason({ ...capable, webgl: false })).toBe('no-webgl');
  });

  it('keeps the static image with Save-Data on', () => {
    expect(heroFallbackReason({ ...capable, saveData: true })).toBe('save-data');
  });

  it('keeps the static image on 4 cores or fewer, or 4 GB of memory or less', () => {
    expect(heroFallbackReason({ ...capable, cores: 4 })).toBe('low-end');
    expect(heroFallbackReason({ ...capable, cores: 2 })).toBe('low-end');
    expect(heroFallbackReason({ ...capable, memoryGb: 4 })).toBe('low-end');
    expect(heroFallbackReason({ ...capable, cores: 6, memoryGb: 6 })).toBeNull();
  });

  it('does not count a value the browser does not report against the device', () => {
    expect(heroFallbackReason({ ...capable, cores: undefined, memoryGb: undefined })).toBeNull();
  });
});

describe('scenePixelRatio', () => {
  it('caps the device pixel ratio at 2', () => {
    expect(scenePixelRatio(1)).toBe(1);
    expect(scenePixelRatio(1.5)).toBe(1.5);
    expect(scenePixelRatio(3)).toBe(2);
    expect(scenePixelRatio(0)).toBe(1);
  });
});

describe('frameDue', () => {
  it('caps the scene at 60 frames a second', () => {
    expect(FRAME_INTERVAL_MS).toBeCloseTo(1000 / 60);
    expect(frameDue(1000, 1000 - FRAME_INTERVAL_MS)).toBe(true);
    // A 120 Hz display calls back every 8.3 ms; every other callback draws.
    expect(frameDue(1008.3, 1000)).toBe(false);
    expect(frameDue(1016.7, 1000)).toBe(true);
    // A 60 Hz display that calls back a little early still draws every frame.
    expect(frameDue(1015.5, 1000)).toBe(true);
  });
});

describe('tokenToHsl', () => {
  it('turns a token value into an hsl() color three.js can parse', () => {
    expect(tokenToHsl('150 100% 45%')).toBe('hsl(150, 100%, 45%)');
    expect(tokenToHsl(' 0 0% 4% ')).toBe('hsl(0, 0%, 4%)');
  });

  it('drops an alpha part and falls back for an empty token', () => {
    expect(tokenToHsl('0 0% 100% / 0.04')).toBe('hsl(0, 0%, 100%)');
    expect(tokenToHsl('', 'hsl(150, 100%, 45%)')).toBe('hsl(150, 100%, 45%)');
  });
});

/** A stand-in for the browser parts afterFirstPaint uses. `paint()` reports first contentful paint. */
function fakeWindow({ paintTiming = true, readyState = 'loading' } = {}) {
  let report: ((list: { getEntriesByName(name: string): unknown[] }) => void) | undefined;
  const idle: Array<() => void> = [];
  const load: Array<() => void> = [];
  const observer = { disconnected: false };
  class FakeObserver {
    static supportedEntryTypes = paintTiming ? ['paint', 'resource'] : ['resource'];
    constructor(callback: typeof report) {
      report = callback;
    }
    observe() {}
    disconnect() {
      observer.disconnected = true;
    }
  }
  const win = {
    PerformanceObserver: FakeObserver,
    requestIdleCallback: (callback: () => void) => idle.push(callback),
    setTimeout: (callback: () => void) => idle.push(callback),
    addEventListener: (_type: string, callback: () => void) => load.push(callback),
    removeEventListener: () => {},
    document: { readyState },
  } as unknown as Window & typeof globalThis;
  return {
    win,
    observer,
    paint: (name = 'first-contentful-paint') =>
      report?.({ getEntriesByName: (wanted) => (wanted === name ? [{ name }] : []) }),
    runIdle: () => {
      for (const callback of idle.splice(0)) callback();
    },
    fireLoad: () => {
      for (const callback of load.splice(0)) callback();
    },
  };
}

describe('afterFirstPaint', () => {
  it('waits for first contentful paint, then for an idle moment', () => {
    const fake = fakeWindow();
    const callback = vi.fn();
    afterFirstPaint(fake.win, callback);

    fake.paint('first-paint');
    fake.runIdle();
    expect(callback).not.toHaveBeenCalled();

    fake.paint();
    expect(callback).not.toHaveBeenCalled();
    fake.runIdle();
    expect(callback).toHaveBeenCalledOnce();
    expect(fake.observer.disconnected).toBe(true);
  });

  it('without paint timing, waits for the load event', () => {
    const fake = fakeWindow({ paintTiming: false });
    const callback = vi.fn();
    afterFirstPaint(fake.win, callback);

    fake.runIdle();
    expect(callback).not.toHaveBeenCalled();
    fake.fireLoad();
    fake.runIdle();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('without paint timing on a loaded page, runs at the next idle moment', () => {
    const fake = fakeWindow({ paintTiming: false, readyState: 'complete' });
    const callback = vi.fn();
    afterFirstPaint(fake.win, callback);
    fake.runIdle();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('does nothing once cancelled', () => {
    const fake = fakeWindow();
    const callback = vi.fn();
    const cancel = afterFirstPaint(fake.win, callback);
    fake.paint();
    cancel();
    fake.runIdle();
    expect(callback).not.toHaveBeenCalled();
  });
});
