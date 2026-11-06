import type { EditOp } from '../document/ops.js';
import {
  type Aspect,
  DESIGN_SIZES,
  type Scene,
  type ScenePicture,
  type StudioDocument,
} from '../document/schema.js';

/**
 * The Pictures step: what each scene shows besides drawn graphics. A picture is planned by the
 * AI, then made ready by a screenshot of the linked project, an image model, or a file the user
 * drops in, and the animator builds the scene around it. These helpers are shared by the
 * service and the UI.
 */

/** Where a scene's pictures sit in its code tree, and in the video's pictures folder. */
export const PICTURES_DIR = 'pictures';
export const PICTURES_MARKDOWN = 'PICTURES.md';

export function scenePictures(scene: Scene): ScenePicture[] {
  return scene.pictures ?? [];
}

export interface PictureCounts {
  total: number;
  ready: number;
  failed: number;
  /** Planned pictures by how they will be made. */
  screenshots: number;
  routeShots: number;
  windowShots: number;
  generate: number;
  files: number;
}

/** How far the video's pictures are, for the step bar and the batch buttons. */
export function pictureCounts(doc: StudioDocument): PictureCounts {
  const counts: PictureCounts = {
    total: 0,
    ready: 0,
    failed: 0,
    screenshots: 0,
    routeShots: 0,
    windowShots: 0,
    generate: 0,
    files: 0,
  };
  for (const scene of doc.scenario.scenes) {
    for (const picture of scenePictures(scene)) {
      counts.total++;
      if (picture.status === 'ready') {
        counts.ready++;
        continue;
      }
      if (picture.status === 'failed') counts.failed++;
      if (picture.source === 'screenshot') {
        counts.screenshots++;
        if (picture.shot?.target === 'window') counts.windowShots++;
        else counts.routeShots++;
      } else if (picture.source === 'generate') counts.generate++;
      else counts.files++;
    }
  }
  return counts;
}

/** A picture that is not ready yet, with the scene it belongs to. */
export interface PendingPicture {
  scene: Scene;
  sceneIndex: number;
  picture: ScenePicture;
}

export function pendingPictures(
  doc: StudioDocument,
  test: (picture: ScenePicture) => boolean = () => true,
): PendingPicture[] {
  const pending: PendingPicture[] = [];
  doc.scenario.scenes.forEach((scene, sceneIndex) => {
    for (const picture of scenePictures(scene)) {
      if (picture.status !== 'ready' && test(picture)) pending.push({ scene, sceneIndex, picture });
    }
  });
  return pending;
}

export function findPicture(
  doc: StudioDocument,
  pictureId: string,
): { scene: Scene; sceneIndex: number; picture: ScenePicture } | null {
  for (const [sceneIndex, scene] of doc.scenario.scenes.entries()) {
    const picture = scenePictures(scene).find((p) => p.id === pictureId);
    if (picture) return { scene, sceneIndex, picture };
  }
  return null;
}

/** The op that changes one picture of a scene. */
export function updatePictureOp(
  scene: Scene,
  pictureId: string,
  patch: Partial<Omit<ScenePicture, 'id'>>,
): EditOp {
  const pictures = scenePictures(scene).map((p) => (p.id === pictureId ? { ...p, ...patch } : p));
  return { op: 'scene.update', sceneId: scene.id, patch: { pictures } };
}

export function removePictureOp(scene: Scene, pictureId: string): EditOp {
  return {
    op: 'scene.update',
    sceneId: scene.id,
    patch: { pictures: scenePictures(scene).filter((p) => p.id !== pictureId) },
  };
}

/** A file name safe for the code tree and any file system: lowercase words joined by dashes. */
export function slugify(text: string, fallback = 'picture'): string {
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** `scene-03-settings.png`, unique among `taken`. */
export function pictureFileName(
  sceneIndex: number,
  label: string,
  taken: ReadonlySet<string>,
  extension = 'png',
): string {
  const base = `scene-${String(sceneIndex + 1).padStart(2, '0')}-${slugify(label)}`;
  let name = `${base}.${extension}`;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}.${extension}`;
  return name;
}

/** Every picture file name the video uses, so a new one never takes an old one's name. */
export function takenFileNames(doc: StudioDocument): Set<string> {
  return new Set(doc.scenario.scenes.flatMap((s) => scenePictures(s).map((p) => p.fileName)));
}

/** The size GPT Image makes for the video's shape: wide, tall or square. */
export function imageSizeFor(aspect: Aspect): '1536x1024' | '1024x1536' | '1024x1024' {
  const { width, height } = DESIGN_SIZES[aspect];
  if (width > height) return '1536x1024';
  if (height > width) return '1024x1536';
  return '1024x1024';
}

/** The aspect ratio Gemini is asked for. */
export function imageAspectFor(aspect: Aspect): string {
  return aspect === '4:5' ? '4:5' : aspect;
}

/** The viewport a screenshot is taken at, in CSS pixels. */
export function shotViewport(viewport: 'desktop' | 'mobile'): { width: number; height: number } {
  return viewport === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 };
}

export const PICTURE_SOURCE_LABELS: Record<ScenePicture['source'], string> = {
  screenshot: 'Screenshot',
  generate: 'AI picture',
  file: 'Your file',
};
