/**
 * What the hero island and its worker say to each other. The worker owns the canvas and its WebGL
 * context, so creating the context and drawing never block the page's main thread.
 */

/** Theme colors as `hsl(...)` strings, the form three.js's `Color.setStyle` reads. */
export interface SceneColors {
  background: string;
  foreground: string;
  primary: string;
  glow: string;
  dark: boolean;
}

/** The canvas size in CSS pixels and the device pixel ratio. */
export interface SceneSize {
  width: number;
  height: number;
  pixelRatio: number;
}

/** From the page to the worker. `start` hands over the canvas; the rest may come before it is ready. */
export type ToHeroWorker =
  | { type: 'start'; canvas: OffscreenCanvas; size: SceneSize; colors: SceneColors }
  | { type: 'size'; size: SceneSize }
  | { type: 'colors'; colors: SceneColors }
  | { type: 'run'; running: boolean };

/** From the worker to the page: the scene is drawing, or the hero keeps its static image. */
export type FromHeroWorker = { type: 'ready' } | { type: 'failed'; reason: 'no-webgl' | 'error' };
