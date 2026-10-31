import type { FromHeroWorker, SceneColors, SceneSize, ToHeroWorker } from './heroMessages';
import type { RunwayScene } from './runwayScene';

/**
 * The hero's worker. It takes the canvas from the island, checks that WebGL 2 works on it, and
 * only then fetches three.js and starts the scene. Creating the first WebGL context can block for
 * hundreds of milliseconds while the GPU starts, which here costs the page nothing.
 */

// The project's types are the DOM ones; this is the part of the worker scope used here.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ToHeroWorker>) => void) | null;
  postMessage(message: FromHeroWorker): void;
};

let scene: RunwayScene | undefined;
// The latest size, colors and run state, kept while three.js loads.
let size: SceneSize | undefined;
let colors: SceneColors | undefined;
let running = false;

scope.onmessage = ({ data }) => {
  switch (data.type) {
    case 'start':
      size = data.size;
      colors = data.colors;
      void start(data.canvas);
      break;
    case 'size':
      size = data.size;
      scene?.setSize(data.size);
      break;
    case 'colors':
      colors = data.colors;
      scene?.setColors(data.colors);
      break;
    case 'run':
      running = data.running;
      scene?.setRunning(data.running);
      break;
  }
};

async function start(canvas: OffscreenCanvas) {
  try {
    const context = canvas.getContext('webgl2', {
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
    });
    if (!context || !size || !colors) {
      scope.postMessage({ type: 'failed', reason: 'no-webgl' });
      return;
    }
    const { createRunwayScene } = await import('./runwayScene');
    scene = createRunwayScene(canvas, context, size, colors);
    scene.setRunning(running);
    scope.postMessage({ type: 'ready' });
  } catch {
    scope.postMessage({ type: 'failed', reason: 'error' });
  }
}
