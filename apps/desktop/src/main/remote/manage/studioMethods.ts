import type {
  ManageStudioChange,
  ManageStudioOptions,
  ManageStudioRender,
  ManageStudioRun,
  ManageStudioVideo,
  ManageStudioVideoDetail,
} from '@runova/protocol';
import type { GenerationView, RenderJobView, StudioEvent, VideoSession } from '@runova/studio';
import { CONTENT_LANGUAGES, STYLE_PRESETS, studioAiInputs, studioInputs } from '@runova/studio';
import type { StudioService } from '@runova/studio/node';
import { ManageError, type ManageMethods } from './session';

type StudioParts = Pick<
  StudioService,
  | 'list'
  | 'create'
  | 'hold'
  | 'release'
  | 'apply'
  | 'undo'
  | 'startScenario'
  | 'startEdit'
  | 'startScene'
  | 'generations'
  | 'cancelGeneration'
  | 'applyProposal'
  | 'discardProposal'
  | 'renderEstimate'
  | 'startRender'
  | 'renderJobs'
  | 'cancelRender'
  | 'thumbnail'
>;

export interface ManageStudioDeps {
  service(): StudioParts;
  onEvent(listener: (event: StudioEvent) => void): () => void;
  now(): number;
}

/** Long enough to outlast a tick or two, short enough that a phone gone away lets go soon. */
export const HOLD_MS = 45_000;
const MAX_LINES = 6;
const MAX_LINE = 200;
const MAX_NARRATION = 600;
const MAX_INSTRUCTION = 300;
const MAX_CHANGES = 30;
const MAX_RENDERS = 5;
const MAX_FIELD = 400;
const HASH = /^[0-9a-f]{64}$/;
const QUALITIES = ['draft', 'standard', 'high', 'master'];
const DEFAULT_RUN = { cliId: null };
const VIDEO_ID = /^[\w-]{1,128}$/;
const MAX_BRIEF = 20_000;
const MAX_TITLE = 200;

function shorten(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function field(params: unknown, name: string): unknown {
  return typeof params === 'object' && params !== null
    ? (params as Record<string, unknown>)[name]
    : undefined;
}

function text(params: unknown, name: string, problem: string, limit = 256): string {
  const value = field(params, name);
  if (typeof value !== 'string' || value.trim() === '' || value.length > limit) {
    throw new ManageError('bad-params', problem);
  }
  return value;
}

function videoRef(params: unknown): string {
  const videoId = text(params, 'videoId', 'Say which video.');
  if (!VIDEO_ID.test(videoId)) throw new ManageError('bad-params', 'That is not a video here.');
  return videoId;
}

/** Studio's own messages are written for people, so they travel as they are. */
async function saying<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ManageError) throw error;
    throw new ManageError('failed', error instanceof Error ? error.message : String(error));
  }
}

function renderOf(job: RenderJobView): ManageStudioRender {
  return {
    id: job.id,
    fileName: job.fileName,
    status: job.status,
    phase: job.phase,
    done: job.done,
    total: job.total,
    durationSeconds: job.durationSeconds,
    finished: job.output !== null,
    error: job.error === null ? null : shorten(job.error, MAX_FIELD),
  };
}

function changesOf(run: GenerationView): ManageStudioChange[] {
  return (run.proposal?.changes ?? []).slice(0, MAX_CHANGES).map((change) => {
    const pair = (before: string, after: string) => ({
      before: shorten(before, MAX_FIELD),
      after: shorten(after, MAX_FIELD),
    });
    switch (change.kind) {
      case 'title':
        return {
          title: 'Title',
          fields: [{ label: 'Title', ...pair(change.before, change.after) }],
        };
      case 'scene-added':
        return { title: `New scene: ${change.title}`, fields: [] };
      case 'scene-removed':
        return { title: `Remove scene: ${change.title}`, fields: [] };
      case 'scene-moved':
        return { title: `Move ${change.title} to place ${change.to + 1}`, fields: [] };
      case 'captions-added':
        return { title: `${change.count} captions`, fields: [] };
      case 'clip-added':
        return { title: `New clip: ${change.label}`, fields: [] };
      case 'clip-removed':
        return { title: `Remove clip: ${change.label}`, fields: [] };
      default: {
        const title =
          change.kind === 'scene-changed'
            ? change.title
            : change.kind === 'clip-changed'
              ? change.label
              : change.kind === 'track-changed'
                ? change.track
                : 'Scenario';
        return {
          title,
          fields: change.changes.map((one) => ({
            label: one.label,
            ...pair(one.before, one.after),
          })),
        };
      }
    }
  });
}

/** The phone's way into Studio. It sees titles, scenes and progress; never a path. */
export function studioMethods(deps: ManageStudioDeps): ManageMethods['calls'] {
  const held = new Map<string, number>();
  const animating = new Set<string>();
  const advancing = new Set<string>();
  const lines = new Map<string, string[]>();
  const stopped = new Map<string, string>();
  let sweeper: ReturnType<typeof setInterval> | null = null;

  function sweep(): void {
    const oldest = deps.now() - HOLD_MS;
    for (const [videoId, seen] of held) {
      if (seen < oldest && !animating.has(videoId)) leave(videoId);
    }
    if (held.size === 0 && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }

  function leave(videoId: string): void {
    held.delete(videoId);
    void deps
      .service()
      .release({ videoId })
      .catch(() => undefined);
  }

  /** Opens the video for the phone, for as long as it keeps asking. */
  async function hold(videoId: string): Promise<VideoSession> {
    const opened = await deps.service().hold({ videoId });
    if (opened.state === 'locked') {
      throw new ManageError('failed', 'Another Runova has this video open.');
    }
    if (opened.state !== 'open') throw new ManageError('failed', 'That video could not be opened.');
    held.set(videoId, deps.now());
    if (!sweeper) {
      sweeper = setInterval(sweep, HOLD_MS / 3);
      sweeper.unref?.();
    }
    return opened.session;
  }

  /** Starts the next scene without a picture, once nothing is running. Runs on the computer. */
  async function advance(videoId: string): Promise<void> {
    if (!animating.has(videoId) || advancing.has(videoId)) return;
    advancing.add(videoId);
    try {
      const service = deps.service();
      const [latest] = await service.generations({ videoId, limit: 1 });
      if (latest?.status === 'running') return;
      if (latest?.stage === 'scene' && latest.status !== 'done' && latest.status !== 'applied') {
        animating.delete(videoId);
        stopped.set(videoId, 'Animating stopped because a scene did not work.');
        return;
      }
      const session = await hold(videoId);
      const next = session.document.scenario.scenes.find((scene) => scene.code.treeHash === null);
      if (!next) {
        animating.delete(videoId);
        return;
      }
      await service.startScene({ videoId, sceneId: next.id, run: DEFAULT_RUN });
    } catch (error) {
      animating.delete(videoId);
      stopped.set(videoId, error instanceof Error ? error.message : String(error));
    } finally {
      advancing.delete(videoId);
    }
  }

  deps.onEvent((event) => {
    if (event.type === 'generation-output') {
      const kept = [...(lines.get(event.generationId) ?? []), ...event.lines].slice(-MAX_LINES);
      lines.set(
        event.generationId,
        kept.map((line) => shorten(line, MAX_LINE)),
      );
    } else if (event.type === 'generation-changed') {
      void advance(event.videoId);
    }
  });

  function runOf(run: GenerationView): ManageStudioRun {
    return {
      id: run.id,
      stage: run.stage,
      status: run.status,
      cliName: run.cliName,
      instruction: shorten(run.instruction, MAX_INSTRUCTION),
      elapsedMs: (run.finishedAt ?? deps.now()) - run.startedAt,
      repairs: Math.max(0, run.attempts.length - 1),
      lines: lines.get(run.id) ?? [],
      error: run.error === null ? null : shorten(run.error, MAX_FIELD),
    };
  }

  return {
    'studio.options': async (): Promise<ManageStudioOptions> => ({
      languages: CONTENT_LANGUAGES.map(({ code, name, native }) => ({ code, name, native })),
      styles: STYLE_PRESETS.map(({ id, name, summary, palette }) => ({
        id,
        name,
        summary,
        colors: palette.slice(0, 4),
      })),
    }),

    'studio.list': async (): Promise<ManageStudioVideo[]> => {
      const service = deps.service();
      const [videos, renders] = await Promise.all([service.list(), service.renderJobs({})]);
      const now = deps.now();
      return videos.map((video) => {
        const latest = renders
          .filter((job) => job.videoId === video.id)
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        return {
          id: video.id,
          title: video.title,
          pinned: video.pinned,
          missing: video.missing,
          openedAgoMs: now - (video.lastOpenedAt ?? video.createdAt),
          render: latest ? renderOf(latest) : null,
        };
      });
    },

    'studio.create': async (params) =>
      saying(async () => {
        const service = deps.service();
        const brief = text(params, 'brief', 'Say what the video is about.', MAX_BRIEF);
        const created = studioInputs.create.safeParse({
          title: shorten(brief.trim().split('\n')[0] ?? brief, MAX_TITLE),
          projectId: null,
          language: field(params, 'language'),
          aspect: field(params, 'aspect'),
        });
        if (!created.success) throw new ManageError('bad-params', 'Check the language and shape.');
        const scenario = studioAiInputs.startScenario.safeParse({
          videoId: 'pending',
          brief,
          targetSeconds: field(params, 'seconds'),
          styleId: field(params, 'styleId') ?? null,
          customStyle: null,
          run: DEFAULT_RUN,
        });
        if (!scenario.success) throw new ManageError('bad-params', 'Check the length and style.');
        const video = await service.create(created.data);
        await hold(video.id);
        await service.startScenario({ ...scenario.data, videoId: video.id });
        return { videoId: video.id };
      }),

    'studio.video': async (params): Promise<ManageStudioVideoDetail> =>
      saying(async () => {
        const videoId = videoRef(params);
        const service = deps.service();
        const session = await hold(videoId);
        const [runs, renders] = await Promise.all([
          service.generations({ videoId, limit: 5 }),
          service.renderJobs({ videoId }),
        ]);
        const running = runs.find((run) => run.status === 'running') ?? null;
        const proposed = runs.find((run) => run.status === 'proposed' && run.proposal) ?? null;
        const failed = runs[0]?.status === 'failed' ? runs[0] : null;
        const settings = session.document.renderSettings;
        return {
          id: videoId,
          title: session.video.title,
          aspect: settings.aspect,
          quality: settings.quality,
          resolution: settings.resolution,
          fps: settings.fps,
          canUndo: session.status.canUndo,
          undoLabel: session.status.undoLabel,
          scenes: session.document.scenario.scenes.map((scene) => ({
            id: scene.id,
            title: scene.title,
            narration: shorten(scene.narration, MAX_NARRATION),
            flicks: scene.targetDuration,
            thumbnail: scene.code.treeHash,
          })),
          run: running ? runOf(running) : null,
          failedRun: failed ? runOf(failed) : null,
          proposal: proposed
            ? {
                generationId: proposed.id,
                summary: shorten(proposed.proposal?.summary ?? '', MAX_FIELD),
                changes: changesOf(proposed),
              }
            : null,
          renders: renders
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, MAX_RENDERS)
            .map(renderOf),
          animatingAll: animating.has(videoId),
          stopped: stopped.get(videoId) ?? null,
        };
      }),

    'studio.leave': async (params) => {
      const videoId = videoRef(params);
      if (!animating.has(videoId) && held.has(videoId)) leave(videoId);
      return { ok: true, message: '' };
    },

    'studio.thumbnail': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        const treeHash = text(params, 'hash', 'Say which picture.');
        if (!HASH.test(treeHash)) throw new ManageError('bad-params', 'That is not a picture.');
        await hold(videoId);
        const png = await deps.service().thumbnail({ videoId, treeHash });
        return { png: png ? Buffer.from(png).toString('base64') : null };
      }),

    'studio.ask': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        await hold(videoId);
        const input = studioAiInputs.startEdit.safeParse({
          videoId,
          instruction: field(params, 'instruction'),
          run: DEFAULT_RUN,
        });
        if (!input.success) throw new ManageError('bad-params', 'Say what to change.');
        await deps.service().startEdit(input.data);
        return { ok: true, message: 'Asked the AI.' };
      }),

    'studio.applyProposal': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        await hold(videoId);
        const generationId = text(params, 'generationId', 'Say which proposal.');
        await deps.service().applyProposal({ videoId, generationId });
        return { ok: true, message: 'Applied.' };
      }),

    'studio.discardProposal': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        await hold(videoId);
        const generationId = text(params, 'generationId', 'Say which proposal.');
        await deps.service().discardProposal({ videoId, generationId });
        return { ok: true, message: 'Discarded.' };
      }),

    'studio.undo': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        await hold(videoId);
        await deps.service().undo({ videoId });
        return { ok: true, message: 'Undone.' };
      }),

    'studio.updateScene': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        const session = await hold(videoId);
        const sceneId = text(params, 'sceneId', 'Say which scene.');
        const title = field(params, 'title');
        const narration = field(params, 'narration');
        const input = studioInputs.apply.safeParse({
          videoId,
          baseSeq: session.status.seq,
          label: 'Edited on the phone',
          ops: [{ op: 'scene.update', sceneId, patch: { title, narration } }],
        });
        if (!input.success)
          throw new ManageError('bad-params', 'That scene text could not be saved.');
        const result = await deps.service().apply(input.data);
        if (!result.ok) throw new ManageError('failed', 'The video changed. Try again.');
        return { ok: true, message: 'Saved.' };
      }),

    'studio.animate': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        await hold(videoId);
        const sceneId = text(params, 'sceneId', 'Say which scene.');
        await deps.service().startScene({ videoId, sceneId, run: DEFAULT_RUN });
        return { ok: true, message: 'Animating.' };
      }),

    'studio.animateAll': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        await hold(videoId);
        stopped.delete(videoId);
        animating.add(videoId);
        await advance(videoId);
        return { ok: true, message: 'Animating every scene.' };
      }),

    'studio.cancelRun': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        animating.delete(videoId);
        const generationId = text(params, 'generationId', 'Say which run.');
        await deps.service().cancelGeneration({ videoId, generationId });
        return { ok: true, message: 'Stopped.' };
      }),

    'studio.renderEstimate': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        await hold(videoId);
        const estimate = await deps.service().renderEstimate({ videoId });
        return estimate.ok
          ? {
              ok: true,
              problems: [],
              width: estimate.width,
              height: estimate.height,
              durationSeconds: estimate.durationSeconds,
              outputBytes: estimate.outputBytes,
              seconds: estimate.seconds,
              warnings: estimate.warnings,
            }
          : { ok: false, problems: estimate.problems, warnings: [] };
      }),

    'studio.render': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        const quality = field(params, 'quality');
        if (typeof quality !== 'string' || !QUALITIES.includes(quality)) {
          throw new ManageError('bad-params', 'Pick a quality.');
        }
        const service = deps.service();
        const session = await hold(videoId);
        const input = studioInputs.apply.safeParse({
          videoId,
          baseSeq: session.status.seq,
          label: 'Render settings',
          ops: [{ op: 'render.set', patch: { quality } }],
        });
        if (!input.success) throw new ManageError('bad-params', 'Pick a quality.');
        if (session.document.renderSettings.quality !== quality) await service.apply(input.data);
        await service.startRender({ videoId });
        return { ok: true, message: 'Rendering on this computer.' };
      }),

    'studio.cancelRender': async (params) =>
      saying(async () => {
        await deps.service().cancelRender({ jobId: text(params, 'jobId', 'Say which render.') });
        return { ok: true, message: 'Render stopped.' };
      }),
  };
}
