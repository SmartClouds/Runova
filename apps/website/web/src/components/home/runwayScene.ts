import {
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  Float32BufferAttribute,
  Fog,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Scene,
  Shape,
  ShapeGeometry,
  Sprite,
  SpriteMaterial,
  TubeGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { FRAME_INTERVAL_MS, frameDue, scenePixelRatio } from '../../lib/heroSupport';
import type { SceneColors, SceneSize } from './heroMessages';

/**
 * The home page hero (T014): the runway and the star from the logo. The runway's center line
 * streams toward the viewer and sparks climb the trail to the star at its far end. Colors come
 * from the theme tokens and follow the theme toggle. The scene draws at most 60 frames a second
 * at a pixel ratio of at most 2. It runs in the hero worker (heroWorker.ts) and touches no DOM;
 * the island tells it its size, its colors and when to run.
 */

export interface RunwayScene {
  setSize(size: SceneSize): void;
  setColors(colors: SceneColors): void;
  setRunning(running: boolean): void;
  dispose(): void;
}

const RUNWAY_HALF_WIDTH = 2.2;
const RUNWAY_NEAR = 6;
const RUNWAY_FAR = -40;
const DASH_SPACING = 4;
const DASH_SPEED = 6;
const SPARKS = 7;
const ENTRANCE_MS = 800;
const GLOW_SIZE = 18;

// Workers have requestAnimationFrame in Chrome and Firefox; elsewhere a timer stands in.
const nextFrame: (callback: (now: number) => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (callback) => requestAnimationFrame(callback)
    : (callback) => self.setTimeout(() => callback(performance.now()), FRAME_INTERVAL_MS);
const cancelFrame: (handle: number) => void =
  typeof cancelAnimationFrame === 'function'
    ? (handle) => cancelAnimationFrame(handle)
    : (handle) => self.clearTimeout(handle);

function starShape(radius: number): Shape {
  const k = radius * 0.12;
  const shape = new Shape();
  shape.moveTo(0, radius);
  shape.quadraticCurveTo(k, k, radius, 0);
  shape.quadraticCurveTo(k, -k, 0, -radius);
  shape.quadraticCurveTo(-k, -k, -radius, 0);
  shape.quadraticCurveTo(-k, k, 0, radius);
  return shape;
}

function glowTexture(): CanvasTexture<OffscreenCanvas> {
  const size = 128;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.3, 'rgba(255,255,255,0.3)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  return new CanvasTexture(canvas);
}

/** Draws on a canvas and WebGL 2 context the worker already has; the context keeps its attributes. */
export function createRunwayScene(
  canvas: OffscreenCanvas,
  context: WebGL2RenderingContext,
  initialSize: SceneSize,
  initialColors: SceneColors,
): RunwayScene {
  const renderer = new WebGLRenderer({ canvas, context });
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  // Framed like the static image: the horizon a third of the way down, the runway's vanishing
  // point a little right of center, and the star up and to the right of its far end.
  const camera = new PerspectiveCamera(42, 4 / 3, 0.1, 120);
  const cameraX = -0.3;
  camera.position.set(cameraX, 2.2, 6);
  const lookAt = new Vector3(-4.9, -3.6, -44);
  camera.lookAt(lookAt);

  const fog = new Fog(0x000000, 14, 52);
  scene.fog = fog;

  // The runway surface and its edge lights.
  const surfaceMaterial = new MeshBasicMaterial({
    transparent: true,
    opacity: 0.09,
    depthWrite: false,
  });
  const surface = new Mesh(
    new PlaneGeometry(RUNWAY_HALF_WIDTH * 2, RUNWAY_NEAR - RUNWAY_FAR),
    surfaceMaterial,
  );
  surface.rotation.x = -Math.PI / 2;
  surface.position.z = (RUNWAY_NEAR + RUNWAY_FAR) / 2;
  scene.add(surface);

  const lightPositions: number[] = [];
  for (let z = RUNWAY_NEAR; z >= RUNWAY_FAR; z -= 2.5) {
    lightPositions.push(-RUNWAY_HALF_WIDTH, 0.05, z, RUNWAY_HALF_WIDTH, 0.05, z);
  }
  const lightGeometry = new BufferGeometry();
  lightGeometry.setAttribute('position', new Float32BufferAttribute(lightPositions, 3));
  const glowMap = glowTexture();
  const lightMaterial = new PointsMaterial({
    size: 0.32,
    map: glowMap,
    transparent: true,
    depthWrite: false,
  });
  scene.add(new Points(lightGeometry, lightMaterial));

  // The center line, moving toward the viewer.
  const dashCount = Math.ceil((RUNWAY_NEAR - RUNWAY_FAR) / DASH_SPACING);
  const dashMaterial = new MeshBasicMaterial({
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  const dashGeometry = new PlaneGeometry(0.1, 1.6);
  dashGeometry.rotateX(-Math.PI / 2);
  const dashes = new InstancedMesh(dashGeometry, dashMaterial, dashCount);
  scene.add(dashes);
  const dummy = new Object3D();

  // The trail from the runway's far end up to the star.
  const starPosition = new Vector3(7.9, 7.8, -42);
  const trail = new CatmullRomCurve3([
    new Vector3(0, 0.1, -36),
    new Vector3(3.5, 0.6, -38),
    new Vector3(6.4, 3.4, -40.5),
    starPosition.clone().add(new Vector3(-0.2, -2.4, 0)),
  ]);
  const trailGeometry = new TubeGeometry(trail, 64, 0.1, 6, false);
  // The trail and the star stand out against the fog that fades the far runway.
  const trailMaterial = new MeshBasicMaterial({ fog: false });
  const trailMesh = new Mesh(trailGeometry, trailMaterial);
  const trailIndexCount = trailGeometry.index?.count ?? 0;
  trailGeometry.setDrawRange(0, 0);
  scene.add(trailMesh);

  // The star and its glow.
  const starMaterial = new MeshBasicMaterial({ fog: false });
  const star = new Mesh(new ShapeGeometry(starShape(2.6), 6), starMaterial);
  star.position.copy(starPosition);
  star.lookAt(camera.position);
  scene.add(star);

  const glowMaterial = new SpriteMaterial({
    map: glowMap,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const glow = new Sprite(glowMaterial);
  glow.position.copy(starPosition);
  glow.scale.set(GLOW_SIZE, GLOW_SIZE, 1);
  scene.add(glow);

  // Sparks climbing the trail.
  const sparkGeometry = new BufferGeometry();
  const sparkPositions = new Float32BufferAttribute(new Float32Array(SPARKS * 3), 3);
  sparkGeometry.setAttribute('position', sparkPositions);
  const sparkMaterial = new PointsMaterial({
    size: 3.2,
    map: glowMap,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const sparks = new Points(sparkGeometry, sparkMaterial);
  // The bounding sphere is computed once while every spark sits at the origin, so culling would
  // hide them for good.
  sparks.frustumCulled = false;
  scene.add(sparks);
  const sparkPoint = new Vector3();

  const white = new Color(0xffffff);
  function applyColors(colors: SceneColors) {
    const foreground = new Color().setStyle(colors.foreground);
    const primary = new Color().setStyle(colors.primary);
    fog.color.setStyle(colors.background);
    surfaceMaterial.color.copy(foreground);
    lightMaterial.color.copy(foreground);
    dashMaterial.color.copy(foreground);
    trailMaterial.color.copy(primary);
    starMaterial.color.copy(primary);
    // In Dark a same-color spark vanishes into the trail; in Light a pale one vanishes into the page.
    sparkMaterial.color.copy(primary).lerp(white, colors.dark ? 0.6 : 0);
    glowMaterial.color.setStyle(colors.glow);
    glowMaterial.opacity = colors.dark ? 0.75 : 0.4;
  }

  function applySize({ width, height, pixelRatio }: SceneSize) {
    renderer.setPixelRatio(scenePixelRatio(pixelRatio));
    renderer.setSize(Math.max(width, 1), Math.max(height, 1), false);
    camera.aspect = Math.max(width, 1) / Math.max(height, 1);
    camera.updateProjectionMatrix();
  }

  applyColors(initialColors);
  applySize(initialSize);

  let started = -1;
  function draw(now: number) {
    if (started < 0) started = now;
    const seconds = (now - started) / 1000;

    for (let i = 0; i < dashCount; i++) {
      const travel = (seconds * DASH_SPEED + i * DASH_SPACING) % (RUNWAY_NEAR - RUNWAY_FAR);
      dummy.position.set(0, 0.03, RUNWAY_FAR + travel);
      dummy.updateMatrix();
      dashes.setMatrixAt(i, dummy.matrix);
    }
    dashes.instanceMatrix.needsUpdate = true;

    // A one-time entrance draws the trail out to the star; after that it stays.
    const grown = Math.min(1, (now - started) / ENTRANCE_MS);
    const eased = 1 - (1 - grown) ** 3;
    trailGeometry.setDrawRange(0, Math.floor((trailIndexCount * eased) / 3) * 3);

    for (let i = 0; i < SPARKS; i++) {
      const t = (seconds * 0.22 + i / SPARKS) % 1;
      trail.getPointAt(t * eased, sparkPoint);
      sparkPositions.setXYZ(i, sparkPoint.x, sparkPoint.y, sparkPoint.z);
    }
    sparkPositions.needsUpdate = true;

    const pulse = 1 + Math.sin(seconds * 1.8) * 0.06;
    star.scale.setScalar(eased * pulse);
    star.rotation.z = Math.sin(seconds * 0.6) * 0.08;
    glow.scale.setScalar(GLOW_SIZE * eased * (1 + Math.sin(seconds * 1.8) * 0.08));

    camera.position.x = cameraX + Math.sin(seconds * 0.25) * 0.25;
    camera.lookAt(lookAt);
    renderer.render(scene, camera);
  }

  let frame = 0;
  let lastFrame = -Infinity;

  function loop(now: number) {
    frame = nextFrame(loop);
    if (!frameDue(now, lastFrame)) return;
    lastFrame = now;
    draw(now);
  }

  return {
    setSize(size) {
      applySize(size);
      if (!frame) draw(performance.now());
    },
    setColors(colors) {
      applyColors(colors);
      if (!frame) draw(performance.now());
    },
    setRunning(running) {
      if (running && !frame) {
        frame = nextFrame(loop);
      } else if (!running && frame) {
        cancelFrame(frame);
        frame = 0;
      }
    },
    dispose() {
      if (frame) cancelFrame(frame);
      frame = 0;
      scene.traverse((object) => {
        const mesh = object as Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) for (const item of material) item.dispose();
        else material?.dispose();
      });
      glowMap.dispose();
      renderer.dispose();
    },
  };
}
