/**
 * The light on the home page. The header's Download button lights up, a thin beam drops from it
 * down the right side of the hero and lands on the top edge of the workspace window. There the
 * light flows like poured water: it spreads along the top edge both ways and pours over the nearer
 * corner, where it falls as a widening sheet of streaks, while haze gathers around the beam. Then it
 * keeps moving: a slow pulse, ripples along the edge, streaks flowing down and drifting haze.
 *
 * Same idea as the hero beam on openbot.run, written from scratch: one WebGL2 context and one
 * fragment shader on a full-screen triangle, no library. No code is copied (openbot.run is
 * PolyForm Noncommercial).
 *
 * It runs in both themes. Added light disappears on a light page, so in Light the shader draws the
 * same light as the theme's deeper green laid over the page. With reduced motion, without WebGL2
 * or after a lost context it never loops: reduced motion gets one still frame of the settled light,
 * and the others get a CSS line in the same place (`data-beam` on the hero tells the CSS which). Cost limits follow the webgl-components skill: the pixel ratio is
 * capped, idle frames run at 30fps, and nothing draws off screen or in a hidden tab.
 */

/** The source lights up, then the tip falls, then the light spreads over the window. */
export const LIGHT_MS = 300;
export const FALL_MS = 1100;
export const LAND_MS = 500;
/** How fast the poured light slows down (per second): it covers 1 - e^(-k * s) of its way. */
const RUN_RATE = 1.15;
/** After the intro, frames are drawn at about 30fps: the slow drift gains nothing from more. */
const IDLE_FRAME_MS = 33;
/** The intro, and a short while after each scroll, run at the display's own rate. */
const INTRO_MS = LIGHT_MS + FALL_MS + 3500;
const SCROLL_SMOOTH_MS = 250;
const MAX_DPR = 1.5;
/** The canvas is never more than this many device pixels on its long side. */
const MAX_SIDE = 2000;

const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;

uniform vec2 uSize;      // canvas size in CSS pixels
uniform float uDpr;      // device pixels per CSS pixel
uniform float uTime;     // seconds
uniform vec4 uSource;    // the button the beam leaves: left, top, right, bottom (canvas CSS px)
uniform vec4 uSurface;   // the window it lands on
uniform float uSurfaceRadius;
uniform float uLit;      // 0 to 1, how far the source has lit up
uniform float uHead;     // y of the falling tip
uniform float uLand;     // 0 until the tip lands, then up to 1
uniform float uFlash;    // 1 at the moment it lands, then fades
uniform float uRun;      // how far the light has flowed from where it landed, in CSS px
uniform vec3 uColor;     // the light's color, always the bright Dark glow
uniform vec3 uInk;       // the theme's own --glow, used to draw the light in Light
uniform float uLight;    // 1 in the Light theme

out vec4 fragColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amount = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amount * noise(p);
    p = p * 2.03 + 17.0;
    amount *= 0.5;
  }
  return value;
}

// 1 below lo, 0 above hi. smoothstep itself must have lo < hi (GLSL leaves the other order
// undefined, and Direct3D gets it wrong), so a fade-out is written as one minus a fade-in.
float fade(float lo, float hi, float x) {
  return 1.0 - smoothstep(lo, hi, x);
}

// Smooth versions of max(x, 0) and min(a, b). A hard one leaves a bend in how fast the light
// changes, and the eye reads a sudden bend as a line, even where nothing jumps.
float softPlus(float x, float k) {
  return max(x, 0.0) + k * log(1.0 + exp(-abs(x) / k));
}

float softMin(float a, float b, float k) {
  return min(a, b) - k * log(1.0 + exp(-abs(a - b) / k));
}

float roundBox(vec2 p, vec2 half_, float radius) {
  vec2 q = abs(p) - half_ + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

void main() {
  // CSS pixels with y going down, like the page.
  vec2 p = vec2(gl_FragCoord.x, uSize.y * uDpr - gl_FragCoord.y) / uDpr;
  float bx = (uSource.x + uSource.z) * 0.5;
  float start = uSource.w;
  float top = uSurface.y;
  float dx = p.x - bx;
  float adx = abs(dx);

  vec3 hot = mix(uColor, vec3(1.0), 0.6);
  vec3 cool = mix(uColor, vec3(0.35, 0.85, 1.0), 0.55);
  float breathe = 1.0 + 0.08 * sin(uTime * 1.3) + 0.04 * sin(uTime * 2.9 + 1.7);
  float land = uLand * breathe;

  // A soft light under the source, where the beam leaves it.
  float mouth = exp(-length(vec2(dx / 18.0, (p.y - start) / 9.0)));
  vec3 col = hot * mouth * 1.2 * uLit;

  // The beam, from the source down to the tip (or to the window once it has landed).
  float end = min(uHead, top);
  float leave = smoothstep(start - 2.0, start + 6.0, p.y);
  float shaft = leave * fade(end - 14.0 - adx * 1.6, end + 2.0 + adx * 0.3, p.y);
  float gather = mix(0.6, 1.0, smoothstep(start, max(top, start + 1.0), p.y));
  float core = exp(-adx / 2.4) + 0.5 * exp(-adx / 5.0);
  float glow = 0.75 * exp(-adx / 13.0) + 0.3 * exp(-adx / 34.0) + 0.12 * exp(-adx / 90.0);
  col += (hot * core * 1.4 + uColor * glow) * shaft * gather * breathe;

  // The falling tip.
  float tip = exp(-length(vec2(dx / 9.0, (p.y - uHead) / 34.0)));
  col += hot * tip * 2.2 * (1.0 - uLand) * smoothstep(start, start + 20.0, uHead);

  // The splash where it lands.
  float flare = exp(-length(vec2(dx / 220.0, (p.y - top) / 46.0)));
  float cloud = exp(-length(vec2(dx / 300.0, (p.y - top) / 90.0)));
  col += uColor * flare * 0.3 * land + hot * flare * 1.6 * uFlash + hot * cloud * 0.35 * land;

  // Poured light. The distance to where it landed is measured along the window's edge: along
  // the top, then over the nearer corner and down that side. The far side stops short of its corner.
  // Every term here changes smoothly in x and y: a step or a cut at a line shows as a seam in the
  // light beside the window, where nothing covers it.
  vec2 center = (uSurface.xy + uSurface.zw) * 0.5;
  vec2 half_ = max((uSurface.zw - uSurface.xy) * 0.5, vec2(1.0));
  float edge = roundBox(p - center, half_, uSurfaceRadius);
  float nearRight = step(center.x, bx);
  float toward = nearRight > 0.5 ? 1.0 : -1.0;
  float sideX = mix(uSurface.x, uSurface.z, nearRight);
  float nearCorner = abs(sideX - bx);
  float farCorner = abs(mix(uSurface.z, uSurface.x, nearRight) - bx);
  float along = dx * toward;
  float below = softPlus(p.y - top, 16.0);
  float path = abs(clamp(along, -farCorner, nearCorner)) + below
    + max(along - nearCorner, 0.0) + max(-along - farCorner, 0.0);
  float farStop = fade(farCorner * 0.6, farCorner * 0.92, max(-along, 0.0));
  float reached = fade(uRun - 8.0, uRun + 40.0, path) * farStop;
  float strength = exp(-softMin(abs(along), nearCorner, 24.0) / 520.0) * exp(-below / 240.0);
  float ripple = 0.8 + 0.2 * sin((path - uTime * 70.0) / 16.0);

  float line = exp(-abs(edge) / 2.2);
  col += hot * line * reached * (0.6 + 1.2 * strength) * ripple * land;
  float halo = exp(-max(edge, 0.0) / 22.0);
  col += uColor * halo * reached * (0.18 + 0.5 * strength) * land;

  // Light rising off the top edge, tall near where it landed and low further out. It is measured
  // from the window's outline, so past a corner it rounds off with the corner instead of being cut
  // off in a line, and beside the window it fades out downwards.
  float rise = exp(-max(edge, 0.0) / (28.0 + 150.0 * exp(-adx / 260.0))) * exp(-below / 120.0);
  col += mix(uColor, cool, 0.25) * rise * reached * (0.08 + 0.55 * exp(-adx / 300.0)) * land;

  // Water off the ledge. Past the nearer corner the light leaves the edge as a sheet that widens
  // as it falls (a pour off a ledge drifts out with the square root of the drop), made of thin
  // streaks flowing down at their own speeds, brightest where it pours over the corner.
  float out_ = (p.x - sideX) * toward;
  float down = max(p.y - top - uSurfaceRadius * 0.5, 0.0);
  float spread = 8.0 + 4.2 * sqrt(down);
  float across = max(out_, 0.0) / spread;
  float strand = across * 26.0;
  float lane = floor(strand);
  float laneSeed = hash(vec2(lane, 7.0));
  float thread = exp(-pow((fract(strand) - 0.5) * 2.0, 2.0) * 2.2);
  float flow = noise(vec2(lane * 3.7, (down - uTime * (70.0 + 110.0 * laneSeed)) / (30.0 + 40.0 * laneSeed)));
  float sheet = smoothstep(-1.0, 1.5, out_) * fade(0.75, 1.05, across) * pow(1.0 - min(across, 1.0), 0.8);
  float falling = smoothstep(top + uSurfaceRadius * 0.3, top + uSurfaceRadius + 18.0, p.y) * exp(-down / 520.0);
  float water = (0.35 + smoothstep(0.35, 0.85, flow) * thread * 1.4) * sheet * falling;
  vec3 waterColor = mix(hot, cool, laneSeed * 0.8);
  col += waterColor * water * reached * mix(2.6, 1.0, uLight) * land;
  // The lip where it pours over the corner.
  vec2 lip = vec2(sideX + toward * 2.0, top + uSurfaceRadius * 0.6);
  col += hot * exp(-length(p - lip) / 22.0) * reached * mix(1.4, 0.6, uLight) * land;

  // A wide soft fan of light over the window. Beside the window it fades out below the top edge
  // instead of stopping at it.
  float fan = exp(-length(vec2(dx / 520.0, (p.y - top) / 260.0))) * exp(-below / 90.0);
  col += uColor * fan * 0.16 * land;

  // Haze drifting around the beam. It thickens once the light has landed.
  vec2 drift = vec2(uTime * 0.02, -uTime * 0.035);
  float warp = fbm(p / 340.0 + drift);
  float smoke = smoothstep(0.38, 0.9, fbm(p / 190.0 + warp * 1.6 + drift * 1.4));
  float lit = exp(-adx / (180.0 + 260.0 * uLand)) * smoothstep(start, start + 160.0, p.y);
  lit *= exp(-below / 140.0);
  col += mix(uColor, cool, 0.3) * smoke * lit * (0.1 + 0.5 * uLand) * mix(1.0, 0.35, uLight);

  // Dust: specks that sink slowly and twinkle where the light is.
  vec2 grid = vec2(p.x, p.y - uTime * 9.0) / 9.0;
  vec2 cell = floor(grid);
  float seed = hash(cell);
  float speck = step(0.993, seed) * fade(0.0, 0.2, length(fract(grid) - 0.5));
  speck *= 0.5 + 0.5 * sin(uTime * 2.0 + seed * 60.0);
  col += hot * speck * exp(-adx / 160.0) * smoothstep(start, start + 160.0, p.y) * 0.6;

  // Nothing is drawn inside the window: it covers that part anyway.
  col *= smoothstep(-1.0, 1.0, edge);
  if (uLight > 0.5) {
    // Added light vanishes on a light page, so in Light the same amounts are drawn as the theme's
    // deeper green (uInk) laid over the page. The strongest parts are the deepest green, so the
    // beam's core reads as its center and not as a pale stripe.
    float amount = 1.0 - exp(-dot(col, vec3(0.25, 0.6, 0.15)) * 1.2);
    float alpha = amount * 0.9;
    fragColor = vec4(uInk * alpha, alpha);
    return;
  }
  col = 1.0 - exp(-col * 1.15);
  fragColor = vec4(col, clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0));
}`;

/** `--glow` is an HSL triplet such as `150 100% 45%`; the shader wants 0..1 RGB. */
export function hslTripletToRgb(value: string): [number, number, number] {
  const match = /^\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*$/.exec(value);
  if (!match) return [0, 0.9, 0.45];
  const h = Number(match[1]) / 360;
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [channel(0), channel(8), channel(4)];
}

/** Device pixels for a canvas of `width` by `height` CSS pixels, within the caps above. */
export function canvasPixels(width: number, height: number, dpr: number) {
  const ratio = Math.min(dpr || 1, MAX_DPR);
  const scale = Math.min(ratio, MAX_SIDE / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

/** How far the source has lit up, 0 to 1. */
export function lighting(elapsed: number): number {
  return clamp01(elapsed / LIGHT_MS);
}

/** Where the falling tip is: it leaves the source once lit and speeds up like a falling drop. */
export function tipY(elapsed: number, from: number, to: number): number {
  const t = clamp01((elapsed - LIGHT_MS) / FALL_MS);
  return from + (to - from) * t * t;
}

/** How far the light has spread over the window's edge, 0 to 1, eased out. */
export function landing(elapsed: number): number {
  const t = clamp01((elapsed - LIGHT_MS - FALL_MS) / LAND_MS);
  return 1 - (1 - t) ** 3;
}

/** How far the poured light has flowed from where it landed: fast at first, then slower. */
export function runLength(elapsed: number, longest: number): number {
  const seconds = (elapsed - LIGHT_MS - FALL_MS) / 1000;
  if (seconds <= 0) return 0;
  return longest * (1 - Math.exp(-RUN_RATE * seconds));
}

type BeamState = 'on' | 'still' | 'fallback';

/**
 * The Dark theme's --glow (design.md). The light keeps this color in both themes; in Light the
 * shader draws it with the theme's own deeper --glow as ink.
 */
const BEAM_COLOR = hslTripletToRgb('150 100% 45%');

interface Program {
  gl: WebGL2RenderingContext;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

const UNIFORMS = [
  'uSize',
  'uDpr',
  'uTime',
  'uSource',
  'uSurface',
  'uSurfaceRadius',
  'uLit',
  'uHead',
  'uLand',
  'uFlash',
  'uRun',
  'uColor',
  'uInk',
  'uLight',
];

function compile(gl: WebGL2RenderingContext): Program | null {
  const shader = (type: number, source: string) => {
    const made = gl.createShader(type);
    if (!made) return null;
    gl.shaderSource(made, source);
    gl.compileShader(made);
    return gl.getShaderParameter(made, gl.COMPILE_STATUS) ? made : null;
  };
  const vertex = shader(gl.VERTEX_SHADER, VERTEX);
  const fragment = shader(gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook.
  gl.useProgram(program);
  const uniforms = Object.fromEntries(
    UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]),
  );
  gl.bindVertexArray(gl.createVertexArray());
  return { gl, uniforms };
}

type Rect = [number, number, number, number];

interface Parts {
  /** Gets `data-beam` with the current state. */
  host: HTMLElement;
  /** The beam layer, holding one canvas. */
  stage: HTMLElement;
  /** The button the beam falls from; it gets `data-beam-struck` once lit. */
  source: HTMLElement;
  /** The window the beam lands on. */
  surface: HTMLElement;
}

export function setUpBeam({ host, stage, source, surface }: Parts) {
  const canvas = stage.querySelector('canvas');
  if (!canvas) return;
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  let program: Program | null = null;
  let lost = false;
  let visible = true;
  let started = 0;
  let lastFrame = 0;
  let smoothUntil = 0;
  let frame = 0;
  let struck = false;

  const setState = (state: BeamState) => {
    host.dataset.beam = state;
  };

  const strike = (on: boolean) => {
    if (on === struck) return;
    struck = on;
    source.toggleAttribute('data-beam-struck', on);
  };

  const ensureProgram = () => {
    if (program || lost) return program;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: true,
      powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: true,
    });
    program = gl ? compile(gl) : null;
    return program;
  };

  /** The layout the shader needs, in the stage's CSS pixels. */
  const measure = () => {
    const stageBox = stage.getBoundingClientRect();
    const local = (box: DOMRect): Rect => [
      box.left - stageBox.left,
      box.top - stageBox.top,
      box.right - stageBox.left,
      box.bottom - stageBox.top,
    ];
    const sourceRect = local(source.getBoundingClientRect());
    const surfaceRect = local(surface.getBoundingClientRect());
    const x = (sourceRect[0] + sourceRect[2]) / 2;
    const [left, top, right, bottom] = surfaceRect;
    return {
      source: sourceRect,
      surface: surfaceRect,
      radius: Number.parseFloat(getComputedStyle(surface).borderTopLeftRadius) || 0,
      // Far enough to cover the top edge and some way down the nearer side.
      longest: Math.max(x - left, right - x) + Math.min(bottom - top, 420),
    };
  };

  /** The CSS line in place of the shader, from the source to the window. */
  const placeFallback = () => {
    const layout = measure();
    stage.style.setProperty('--beam-x', `${(layout.source[0] + layout.source[2]) / 2}px`);
    stage.style.setProperty('--beam-from', `${layout.source[3]}px`);
    stage.style.setProperty('--beam-to', `${layout.surface[1]}px`);
  };

  const draw = (now: number, settled: boolean) => {
    if (!program) return;
    const { gl, uniforms } = program;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const pixels = canvasPixels(width, height, devicePixelRatio);
    if (canvas.width !== pixels.width || canvas.height !== pixels.height) {
      canvas.width = pixels.width;
      canvas.height = pixels.height;
    }
    const layout = measure();
    const elapsed = settled ? INTRO_MS * 3 : now - started;
    const glow = getComputedStyle(root).getPropertyValue('--glow');
    const sinceLanding = elapsed - LIGHT_MS - FALL_MS;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(uniforms.uSize, width, height);
    gl.uniform1f(uniforms.uDpr, pixels.scale);
    gl.uniform1f(uniforms.uTime, settled ? 0 : now / 1000);
    gl.uniform4f(uniforms.uSource, ...layout.source);
    gl.uniform4f(uniforms.uSurface, ...layout.surface);
    gl.uniform1f(uniforms.uSurfaceRadius, layout.radius);
    gl.uniform1f(uniforms.uLit, lighting(elapsed));
    gl.uniform1f(uniforms.uHead, tipY(elapsed, layout.source[3], layout.surface[1]));
    gl.uniform1f(uniforms.uLand, landing(elapsed));
    gl.uniform1f(uniforms.uFlash, sinceLanding < 0 ? 0 : Math.exp(-sinceLanding / 260));
    gl.uniform1f(uniforms.uRun, runLength(elapsed, layout.longest));
    gl.uniform3fv(uniforms.uColor, BEAM_COLOR);
    gl.uniform3fv(uniforms.uInk, hslTripletToRgb(glow));
    gl.uniform1f(uniforms.uLight, root.classList.contains('dark') ? 0 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    strike(elapsed >= LIGHT_MS / 2);
  };

  const loop = (now: number) => {
    frame = 0;
    if (!visible || document.hidden || !program) return;
    const smooth = now - started < INTRO_MS || now < smoothUntil;
    if (smooth || now - lastFrame >= IDLE_FRAME_MS) {
      lastFrame = now;
      draw(now, false);
    }
    frame = requestAnimationFrame(loop);
  };

  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const resume = () => {
    if (!frame && host.dataset.beam === 'on' && visible && !document.hidden) {
      frame = requestAnimationFrame(loop);
    }
  };

  /** Picks the state for the current theme and motion setting, and starts or stops the loop. */
  const update = () => {
    stop();
    if (!ensureProgram()) {
      placeFallback();
      strike(true);
      setState('fallback');
      return;
    }
    if (reduced.matches) {
      setState('still');
      draw(performance.now(), true);
      return;
    }
    setState('on');
    started = performance.now();
    lastFrame = 0;
    strike(false);
    resume();
  };

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    lost = true;
    program = null;
    update();
  });

  new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    if (visible) resume();
    else stop();
  }).observe(stage);

  // The source sits in the sticky header and the window scrolls with the page, so the beam is
  // redrawn at full rate while the page moves, or it would lag behind the header.
  addEventListener(
    'scroll',
    () => {
      smoothUntil = performance.now() + SCROLL_SMOOTH_MS;
      const state = host.dataset.beam;
      if (state === 'still') draw(performance.now(), true);
      else if (state === 'fallback') placeFallback();
    },
    { passive: true },
  );

  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : resume()));
  // Only a theme switch restarts the beam, not any other class on <html>.
  let dark = root.classList.contains('dark');
  new MutationObserver(() => {
    if (root.classList.contains('dark') === dark) return;
    dark = !dark;
    update();
  }).observe(root, { attributes: true, attributeFilter: ['class'] });
  reduced.addEventListener('change', update);
  new ResizeObserver(() => {
    const state = host.dataset.beam;
    if (state === 'still') draw(performance.now(), true);
    else if (state === 'fallback') placeFallback();
  }).observe(stage);

  update();
}

/** Starts the beam once the browser is idle, so it never competes with the first paint. */
export function setUpBeamWhenIdle(parts: Parts) {
  const start = () => setUpBeam(parts);
  if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 400 });
  else setTimeout(start, 0);
}
