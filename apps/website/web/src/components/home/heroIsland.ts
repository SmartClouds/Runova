import {
  afterFirstPaint,
  heroFallbackReason,
  readHeroEnvironment,
  readSceneColors,
} from '../../lib/heroSupport';
import type { FromHeroWorker, SceneSize, ToHeroWorker } from './heroMessages';

/**
 * Mounts the hero scene in `host`, which sits over the hero's static image inside the
 * `[data-hero]` element. HeroScene.astro calls it once the hero is visible. It decides whether the
 * three.js scene may run, then, once the first paint is on screen, hands a canvas to the hero
 * worker, which checks WebGL and only then fetches three.js and draws. So reduced motion, no
 * WebGL, Save-Data and low-end devices never download three.js, and the scene never blocks the
 * main thread. It keeps the observers and tells the worker its size, its colors and when to run.
 * The state goes on the `[data-hero]` element for CSS and tests: `static` (with `data-reason`),
 * `loading`, `running` or `paused`. Returns a function that stops everything.
 */
export function mountHeroScene(host: HTMLElement): () => void {
  const hero = host.closest<HTMLElement>('[data-hero]');
  if (!hero) return () => {};

  const reason = heroFallbackReason(readHeroEnvironment(window));
  if (reason) {
    hero.dataset.state = 'static';
    hero.dataset.reason = reason;
    return () => {};
  }

  let stop: (() => void) | undefined;
  const cancel = afterFirstPaint(window, () => {
    stop = startScene(host, hero);
  });
  return () => {
    cancel();
    stop?.();
  };
}

/** Starts the worker on a new canvas in `element` and returns a function that stops it. */
function startScene(element: HTMLElement, hero: HTMLElement): () => void {
  hero.dataset.state = 'loading';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.className = 'absolute inset-0 h-full w-full';
  element.append(canvas);
  const offscreen = canvas.transferControlToOffscreen();
  const worker = new Worker(new URL('./heroWorker.ts', import.meta.url), { type: 'module' });
  const post = (message: ToHeroWorker, transfer: Transferable[] = []) =>
    worker.postMessage(message, transfer);
  const size = (): SceneSize => ({
    width: element.clientWidth,
    height: element.clientHeight,
    pixelRatio: window.devicePixelRatio,
  });

  let ready = false;
  let onScreen = false;
  function update() {
    const running = onScreen && document.visibilityState === 'visible';
    post({ type: 'run', running });
    if (ready) hero.dataset.state = running ? 'running' : 'paused';
  }

  const visibility = new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    update();
  });
  const sizing = new ResizeObserver(() => post({ type: 'size', size: size() }));
  const theme = new MutationObserver(() =>
    post({ type: 'colors', colors: readSceneColors(window) }),
  );

  function stop() {
    visibility.disconnect();
    sizing.disconnect();
    theme.disconnect();
    document.removeEventListener('visibilitychange', update);
    worker.terminate();
    canvas.remove();
  }

  worker.onmessage = ({ data }: MessageEvent<FromHeroWorker>) => {
    if (data.type === 'ready') {
      ready = true;
      update();
      return;
    }
    stop();
    hero.dataset.state = 'static';
    hero.dataset.reason = data.reason;
  };
  worker.onerror = () => {
    stop();
    hero.dataset.state = 'static';
    hero.dataset.reason = 'error';
  };

  post({ type: 'start', canvas: offscreen, size: size(), colors: readSceneColors(window) }, [
    offscreen,
  ]);
  visibility.observe(element);
  sizing.observe(element);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', update);

  return stop;
}
