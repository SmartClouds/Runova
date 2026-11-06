import { z } from 'zod';
import type { EditOp } from '../../document/ops.js';
import {
  MAX_SCENE_PICTURES,
  MAX_SHOT_STEPS,
  type ScenePicture,
  type StudioDocument,
  shotSchema,
} from '../../document/schema.js';
import { pictureFileName, scenePictures } from '../../pictures/pictures.js';
import { formatIssues } from '../answerShapes.js';
import { extractJson } from '../extractJson.js';
import type { AnswerRead } from '../scenario/answer.js';

/** What the Pictures run answers with: the app to capture, and each scene's pictures. */

const aiShot = z.preprocess((value) => {
  if (!value || typeof value !== 'object') return value;
  const shot = value as { target?: unknown; path?: unknown; viewport?: unknown; steps?: unknown };
  // A shot with a path but no target is a route shot, the usual kind.
  const target = shot.target ?? (typeof shot.path === 'string' ? 'route' : undefined);
  if (target !== 'route') return value;
  return {
    ...shot,
    target,
    viewport: shot.viewport === 'mobile' ? 'mobile' : 'desktop',
    ...(Array.isArray(shot.steps) ? { steps: shot.steps.slice(0, MAX_SHOT_STEPS) } : {}),
  };
}, shotSchema);

const aiPicture = z.object({
  purpose: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe('What the picture shows and what the animator should point at.'),
  label: z.string().trim().min(1).max(60).describe('Two or three English words for the file name.'),
  source: z.enum(['screenshot', 'generate', 'file']),
  shot: aiShot.optional().describe('How to take the screenshot. Only for "screenshot".'),
  prompt: z
    .string()
    .trim()
    .max(4000)
    .optional()
    .describe('The full picture prompt. For "generate" and "file".'),
});
type AiPicture = z.infer<typeof aiPicture>;

export const picturesAnswerSchema = z.object({
  app: z
    .object({
      kind: z.enum(['web', 'desktop', 'none']),
      runCommandId: z.string().max(200).nullable().default(null),
      url: z.string().max(500).nullable().default(null),
    })
    .default({ kind: 'none', runCommandId: null, url: null }),
  scenes: z
    .array(
      z.object({
        sceneId: z.string().min(1).max(64),
        pictures: z.array(aiPicture).max(3),
      }),
    )
    .max(500),
});
export type PicturesAnswer = z.infer<typeof picturesAnswerSchema>;

export interface PicturesPlan {
  app: PicturesAnswer['app'];
  ops: EditOp[];
  /** How many pictures the plan has, for the run's summary. */
  count: number;
}

export interface ReadPicturesOptions {
  /** A project is linked, so screenshots can be taken. */
  hasProject: boolean;
  /** An image model is set up; without one, "generate" becomes "file". */
  canGenerate: boolean;
  newId: () => string;
}

/** A localhost address the capture may open, or null for anything else. */
export function localAppUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(url.hostname)) return null;
    // 0.0.0.0 is where a server listens, not an address to open.
    if (url.hostname === '0.0.0.0') url.hostname = 'localhost';
    return url.origin;
  } catch {
    return null;
  }
}

export function readPicturesAnswer(
  text: string,
  doc: StudioDocument,
  options: ReadPicturesOptions,
): AnswerRead<PicturesPlan> {
  const json = extractJson(text);
  if (!json.ok) return { ok: false, issues: [json.reason] };
  const parsed = picturesAnswerSchema.safeParse(json.value);
  if (!parsed.success) return { ok: false, issues: formatIssues(parsed.error) };
  const answer = parsed.data;
  const issues: string[] = [];
  const ids = new Set(doc.scenario.scenes.map((s) => s.id));
  for (const entry of answer.scenes) {
    if (!ids.has(entry.sceneId))
      issues.push(`There is no scene with the sceneId "${entry.sceneId}".`);
    entry.pictures.forEach((picture, at) => {
      const where = `Scene "${entry.sceneId}", picture ${at + 1}`;
      if (picture.source === 'screenshot' && !options.hasProject) {
        issues.push(`${where} is a screenshot, but there is no project to take it of. Use "file".`);
      }
      if (picture.source === 'screenshot' && !picture.shot) {
        issues.push(`${where} is a screenshot without a "shot" saying how to take it.`);
      }
      if (picture.source === 'generate' && options.canGenerate && !picture.prompt) {
        issues.push(`${where} is generated but has no "prompt".`);
      }
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: picturesPlan(doc, answer, options) };
}

/**
 * The edit that puts a plan into the video. Pictures that are ready stay; everything still
 * planned or failed is replaced by the new plan, so planning again starts fresh.
 */
export function picturesPlan(
  doc: StudioDocument,
  answer: PicturesAnswer,
  options: ReadPicturesOptions,
): PicturesPlan {
  const byScene = new Map(answer.scenes.map((s) => [s.sceneId, s.pictures]));
  const taken = new Set(
    doc.scenario.scenes.flatMap((s) =>
      scenePictures(s)
        .filter((p) => p.status === 'ready')
        .map((p) => p.fileName),
    ),
  );
  const ops: EditOp[] = [];
  let count = 0;
  doc.scenario.scenes.forEach((scene, sceneIndex) => {
    const before = scenePictures(scene);
    const kept = before.filter((p) => p.status === 'ready');
    const planned = (byScene.get(scene.id) ?? [])
      .slice(0, Math.max(0, MAX_SCENE_PICTURES - kept.length))
      .map((ai) => toPicture(ai, sceneIndex, taken, options));
    count += planned.length;
    const pictures = [...kept, ...planned];
    if (pictures.length === 0 && before.length === 0) return;
    if (JSON.stringify(pictures) === JSON.stringify(before)) return;
    ops.push({ op: 'scene.update', sceneId: scene.id, patch: { pictures } });
  });
  return {
    app: { ...answer.app, url: localAppUrl(answer.app.url) },
    ops,
    count,
  };
}

function toPicture(
  ai: AiPicture,
  sceneIndex: number,
  taken: Set<string>,
  options: ReadPicturesOptions,
): ScenePicture {
  const fileName = pictureFileName(sceneIndex, ai.label, taken);
  taken.add(fileName);
  const source = ai.source === 'generate' && !options.canGenerate ? 'file' : ai.source;
  return {
    id: options.newId(),
    purpose: ai.purpose,
    source,
    status: 'planned',
    ...(source === 'screenshot' && ai.shot ? { shot: ai.shot } : {}),
    ...(source !== 'screenshot' ? { prompt: ai.prompt || ai.purpose } : {}),
    fileName,
    mediaHash: null,
    genJobId: null,
    error: null,
  };
}
