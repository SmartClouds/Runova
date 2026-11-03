import {
  type EditOp,
  flicksToSeconds,
  type Scene,
  studioInputs,
  type VideoSession,
  type VideoSummary,
} from '@runova/studio';
import { z } from 'zod';
import { studioService } from '../../studio';
import { defineTool } from '../registry';
import { projectIdArg, projectIdOf } from './shared';

/**
 * Studio tools: the videos in the Studio library, one video's scenario and scenes, and plain text
 * edits to them. They call the same Studio service the IPC channels do (main/studio's index), and
 * an edit goes in as one apply, so it lands in the video's history and Undo takes it back.
 *
 * Reading a video means opening it. When the editor already has it open, that is the same session;
 * when it was closed, it is closed again afterwards so its folder lock is not held for nothing.
 * Rendering is left out: it is slow, uses the machine for a long time, and the user starts it.
 */

const videoArg = z
  .string()
  .min(1)
  .describe('The video, by its title (any case) or id. studio_list_videos lists them.');

const sceneArg = z
  .string()
  .min(1)
  .describe('The scene, by its number in the video (1 is the first), its title or its id.');

async function findVideo(ref: string): Promise<VideoSummary> {
  const videos = await studioService().list();
  const wanted = ref.trim().toLowerCase();
  const found =
    videos.find((one) => one.id === ref) ??
    videos.find((one) => one.title.trim().toLowerCase() === wanted);
  if (found) return found;
  const titles = videos.map((one) => one.title).join(', ');
  throw new Error(
    titles
      ? `No Studio video titled ${ref}. The library has: ${titles}.`
      : 'The Studio library has no videos yet.',
  );
}

/** Opens the video, hands its session to `work`, and closes it again if it was closed before. */
async function withVideo<T>(
  ref: string,
  work: (session: VideoSession, video: VideoSummary) => Promise<T>,
): Promise<T> {
  const video = await findVideo(ref);
  const service = studioService();
  const opened = await service.open({ videoId: video.id });
  if (opened.state === 'locked') {
    throw new Error(
      `${video.title} is open in Runova on ${opened.holder.host}. Close it there first.`,
    );
  }
  if (opened.state === 'missing') {
    throw new Error(
      `The folder of ${video.title} is missing. Use Locate in Studio to find it again.`,
    );
  }
  if (opened.state === 'error') throw new Error(`Could not open ${video.title}: ${opened.message}`);
  // Opening a closed video stamps it as opened now; one the editor holds keeps its old stamp.
  const openedHere = opened.session.video.lastOpenedAt !== video.lastOpenedAt;
  try {
    return await work(opened.session, video);
  } finally {
    if (openedHere) await service.close({ videoId: video.id }).catch(() => undefined);
  }
}

function findScene(session: VideoSession, ref: string): Scene {
  const scenes = session.document.scenario.scenes;
  const trimmed = ref.trim();
  const number = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
  const found =
    scenes.find((one) => one.id === trimmed) ??
    (number !== null ? scenes[number - 1] : undefined) ??
    scenes.find((one) => one.title.trim().toLowerCase() === trimmed.toLowerCase());
  if (found) return found;
  const titles = scenes.map((one) => one.title || one.id).join(', ');
  throw new Error(
    titles
      ? `No scene ${ref} in ${session.video.title}. Its scenes: ${titles}.`
      : `${session.video.title} has no scenes yet.`,
  );
}

/** Applies the ops on top of the version just read, as one step in the video's history. */
async function applyEdit(session: VideoSession, ops: EditOp[], label: string): Promise<void> {
  const input = { videoId: session.video.id, baseSeq: session.status.seq, ops, label };
  const parsed = studioInputs.apply.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.');
    throw new Error(`That edit is not valid${field ? ` (${field})` : ''}: ${issue?.message ?? ''}`);
  }
  const result = await studioService().apply(parsed.data);
  if (!result.ok) {
    throw new Error(
      `${session.video.title} changed while this edit was being made. Read it again and retry.`,
    );
  }
}

/** Only the values that were given, so the rest of the scene or scenario stays as it is. */
function given<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

const sceneText = z.string().max(500);
const sceneLongText = z.string().max(20_000);

export const studioTools = [
  defineTool({
    name: 'studio_list_videos',
    area: 'studio',
    title: 'List Studio videos',
    description:
      'The videos in the Studio library with their folder and linked project. With forProject, only the videos linked to the project.',
    risk: 'read',
    input: z.object({ projectId: projectIdArg, forProject: z.boolean().optional() }),
    preview: () => ({ title: 'List the Studio videos' }),
    async run(args, context) {
      const videos = args.forProject
        ? await studioService().list({ projectId: projectIdOf(context) })
        : await studioService().list();
      return {
        data: videos.map((video) => ({
          id: video.id,
          title: video.title,
          folder: video.folder,
          projectId: video.linkedProjectId,
          missing: video.missing,
          lastOpenedAt: video.lastOpenedAt ? new Date(video.lastOpenedAt).toISOString() : null,
        })),
      };
    },
  }),

  defineTool({
    name: 'studio_video_details',
    area: 'studio',
    title: 'Read a Studio video',
    description:
      "A video's scenario (logline, audience, tone) and its scenes in order: title, narration, on-screen text, length in seconds, visual brief and notes. Also how many tracks and clips the timeline has.",
    risk: 'read',
    input: z.object({ video: videoArg }),
    preview: (args) => ({ title: `Read the Studio video ${args.video}` }),
    run: (args) =>
      withVideo(args.video, async (session, video) => {
        const { document } = session;
        return {
          data: {
            id: video.id,
            title: document.title,
            language: document.language,
            styleId: document.styleId,
            scenario: {
              logline: document.scenario.logline,
              audience: document.scenario.audience,
              tone: document.scenario.tone,
            },
            scenes: document.scenario.scenes.map((scene, index) => ({
              number: index + 1,
              id: scene.id,
              title: scene.title,
              narration: scene.narration,
              onScreenText: scene.onScreenText,
              seconds: Math.round(flicksToSeconds(scene.targetDuration) * 10) / 10,
              timing: scene.timing,
              visualKind: scene.visualKind,
              visualBrief: scene.visualBrief,
              musicCue: scene.musicCue,
              notes: scene.notes,
              hasCode: scene.code.treeHash !== null,
            })),
            timeline: {
              tracks: document.timeline.tracks.length,
              clips: document.timeline.clips.length,
            },
            version: session.status.seq,
          },
        };
      }),
  }),

  defineTool({
    name: 'studio_update_scene',
    area: 'studio',
    title: 'Edit a Studio scene',
    description:
      "Changes a scene's text: title, narration, on-screen text, visual brief, music cue or notes. Only the values given change. The edit lands in the video's history, so the user can undo it.",
    risk: 'write',
    input: z.object({
      video: videoArg,
      scene: sceneArg,
      title: sceneText.optional(),
      narration: sceneLongText.optional(),
      onScreenText: z.array(sceneText).max(50).optional(),
      visualBrief: sceneLongText.optional(),
      musicCue: sceneText.optional(),
      notes: sceneLongText.optional(),
    }),
    preview: (args) => {
      const { video, scene, ...values } = args;
      return {
        title: `Edit scene ${scene} of the Studio video ${video}`,
        fields: Object.entries(given(values)).map(([label, value]) => ({
          label,
          value: Array.isArray(value) ? value.join(' | ') : String(value),
        })),
      };
    },
    run: (args) =>
      withVideo(args.video, async (session) => {
        const { video: _video, scene: sceneRef, ...values } = args;
        const scene = findScene(session, sceneRef);
        const patch = given(values);
        if (Object.keys(patch).length === 0) {
          throw new Error('Nothing to change. Pass at least one value to set.');
        }
        const name = scene.title || scene.id;
        await applyEdit(
          session,
          [{ op: 'scene.update', sceneId: scene.id, patch }],
          `Agent edit: scene ${name}`,
        );
        return { text: `Updated scene ${name} in ${session.video.title}.` };
      }),
  }),

  defineTool({
    name: 'studio_update_video',
    area: 'studio',
    title: 'Edit a Studio video scenario',
    description:
      "Changes a video's title, or its scenario's logline, audience or tone. Only the values given change. The edit lands in the video's history, so the user can undo it.",
    risk: 'write',
    input: z.object({
      video: videoArg,
      title: z.string().trim().min(1).max(500).optional(),
      logline: sceneLongText.optional(),
      audience: sceneText.optional(),
      tone: sceneText.optional(),
    }),
    preview: (args) => {
      const { video, ...values } = args;
      return {
        title: `Edit the Studio video ${video}`,
        fields: Object.entries(given(values)).map(([label, value]) => ({
          label,
          value: String(value),
        })),
      };
    },
    run: (args) =>
      withVideo(args.video, async (session) => {
        const ops: EditOp[] = [];
        if (args.title !== undefined)
          ops.push({ op: 'doc.set', field: 'title', value: args.title });
        const scenario = given({ logline: args.logline, audience: args.audience, tone: args.tone });
        if (Object.keys(scenario).length > 0) ops.push({ op: 'scenario.set', patch: scenario });
        if (ops.length === 0) throw new Error('Nothing to change. Pass at least one value to set.');
        await applyEdit(session, ops, 'Agent edit: video details');
        return { text: `Updated ${args.title ?? session.video.title}.` };
      }),
  }),
];
