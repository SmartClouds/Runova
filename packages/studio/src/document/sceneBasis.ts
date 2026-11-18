import { scenePictures } from '../pictures/pictures.js';
import { hashString } from '../runtime/motion.js';
import { flicksToSeconds } from '../time/flicks.js';
import type { Scene, SceneBasis } from './schema.js';

/** The fields a scene's animation is made from, in the order the scene card shows them. */
export const SCENE_BASIS_FIELDS = [
  'title',
  'narration',
  'onScreenText',
  'visualBrief',
  'length',
  'pictures',
] as const satisfies readonly (keyof SceneBasis)[];
export type SceneBasisField = (typeof SCENE_BASIS_FIELDS)[number];

function part(text: string): string {
  return hashString(text).toString(16).padStart(8, '0');
}

/**
 * A short fingerprint of each scene field the AI animates from. The length is rounded the way the
 * animation prompt rounds it, and only ready pictures count, since only those reach the AI.
 */
export function sceneBasis(scene: Scene): SceneBasis {
  const seconds = Math.round(flicksToSeconds(scene.targetDuration) * 10) / 10;
  const pictures = scenePictures(scene)
    .filter((p) => p.status === 'ready' && p.mediaHash)
    .map((p) => `${p.fileName}:${p.mediaHash}`);
  return {
    title: part(scene.title),
    narration: part(scene.narration),
    onScreenText: part(JSON.stringify(scene.onScreenText)),
    visualBrief: part(scene.visualBrief),
    length: part(String(seconds)),
    pictures: part(JSON.stringify(pictures)),
  };
}

/**
 * The fields that changed since the scene was animated. Nothing when the scene has no animation,
 * or no record of what it was made from (older videos, code put back from an earlier version).
 */
export function sceneBasisChanges(scene: Scene): SceneBasisField[] {
  const before = scene.code.basis;
  if (!scene.code.treeHash || !before) return [];
  const now = sceneBasis(scene);
  return SCENE_BASIS_FIELDS.filter((field) => now[field] !== before[field]);
}
