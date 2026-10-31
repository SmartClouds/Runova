import type { SceneColors } from '../components/home/heroMessages';

/**
 * When the home page hero may run its three.js scene (docs/website/design.md, Motion). Anything
 * else keeps the static image, and the three.js chunk is never fetched.
 */

export interface HeroEnvironment {
  reducedMotion: boolean;
  /**
   * The browser can hand a canvas to a worker (the scene draws there). Whether WebGL 2 works is
   * only known once the worker asks for a context, which it reports as `no-webgl` too.
   */
  webgl: boolean;
  /** `navigator.hardwareConcurrency`, when the browser reports it. */
  cores?: number;
  /** `navigator.deviceMemory` in GB, when the browser reports it. */
  memoryGb?: number;
  /** The visitor has Save-Data on. */
  saveData: boolean;
}

export type HeroFallbackReason = 'reduced-motion' | 'no-webgl' | 'save-data' | 'low-end';

/** Why the hero keeps its static image, or null when the scene may run. */
export function heroFallbackReason(env: HeroEnvironment): HeroFallbackReason | null {
  if (env.reducedMotion) return 'reduced-motion';
  if (!env.webgl) return 'no-webgl';
  if (env.saveData) return 'save-data';
  if (env.cores !== undefined && env.cores <= 4) return 'low-end';
  if (env.memoryGb !== undefined && env.memoryGb <= 4) return 'low-end';
  return null;
}

/**
 * Reads the environment from the browser. It creates no WebGL context: the first one can block
 * the main thread for hundreds of milliseconds while the GPU starts, so the worker makes it.
 */
export function readHeroEnvironment(win: Window & typeof globalThis): HeroEnvironment {
  const nav = win.navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  return {
    reducedMotion: win.matchMedia('(prefers-reduced-motion: reduce)').matches,
    webgl:
      typeof win.Worker === 'function' &&
      typeof win.OffscreenCanvas === 'function' &&
      typeof win.WebGL2RenderingContext === 'function' &&
      typeof win.HTMLCanvasElement.prototype.transferControlToOffscreen === 'function',
    cores: nav.hardwareConcurrency || undefined,
    memoryGb: nav.deviceMemory || undefined,
    saveData: nav.connection?.saveData === true,
  };
}

/** The scene draws at the device pixel ratio, capped at 2. */
export function scenePixelRatio(devicePixelRatio: number): number {
  return Math.min(Math.max(devicePixelRatio || 1, 1), 2);
}

/** The scene draws at most 60 frames a second. */
export const FRAME_INTERVAL_MS = 1000 / 60;

/** Whether enough time has passed since the last drawn frame. A display at 60 Hz may call back a
 * little early, so the check allows 2 ms of slack; one at 120 Hz draws every other callback. */
export function frameDue(now: number, lastFrame: number): boolean {
  return now - lastFrame >= FRAME_INTERVAL_MS - 2;
}

/**
 * A theme token such as `150 100% 45%` as `hsl(150, 100%, 45%)`, the form three.js's
 * `Color.setStyle` reads. An alpha part is dropped; an empty token gives the fallback.
 */
export function tokenToHsl(token: string, fallback = 'hsl(0, 0%, 50%)'): string {
  const parts = token.split('/')[0].trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 3) return fallback;
  return `hsl(${parts.join(', ')})`;
}

/** The theme tokens the scene draws with, read from the page for the worker. */
export function readSceneColors(win: Window): SceneColors {
  const root = win.document.documentElement;
  const style = win.getComputedStyle(root);
  const color = (name: string, fallback: string) =>
    tokenToHsl(style.getPropertyValue(name), fallback);
  return {
    background: color('--background', 'hsl(0, 0%, 4%)'),
    foreground: color('--foreground', 'hsl(0, 0%, 95%)'),
    primary: color('--primary', 'hsl(150, 100%, 45%)'),
    glow: color('--glow', 'hsl(150, 100%, 45%)'),
    dark: root.classList.contains('dark'),
  };
}

/**
 * Calls back once the page's first contentful paint is on screen and the browser is idle, and
 * returns a cancel function. The hero starts its worker then: a WebGL context asked for any
 * earlier competes with the first frame for the GPU and delays it. Without paint timing it waits
 * for the load event instead.
 */
export function afterFirstPaint(win: Window & typeof globalThis, callback: () => void): () => void {
  let cancelled = false;
  let observer: PerformanceObserver | undefined;
  const run = () => {
    if (!cancelled) callback();
  };
  const idle = () => {
    if (cancelled) return;
    if (typeof win.requestIdleCallback === 'function')
      win.requestIdleCallback(run, { timeout: 1000 });
    else win.setTimeout(run, 0);
  };

  if (win.PerformanceObserver?.supportedEntryTypes?.includes('paint')) {
    observer = new win.PerformanceObserver((list) => {
      if (list.getEntriesByName('first-contentful-paint').length === 0) return;
      observer?.disconnect();
      idle();
    });
    observer.observe({ type: 'paint', buffered: true });
  } else if (win.document.readyState === 'complete') {
    idle();
  } else {
    win.addEventListener('load', idle, { once: true });
  }

  return () => {
    cancelled = true;
    observer?.disconnect();
    win.removeEventListener('load', idle);
  };
}
