import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type {
  ManageStudioChange,
  ManageStudioOptions,
  ManageStudioRender,
  ManageStudioRun,
  ManageStudioVideo,
  ManageStudioVideoDetail,
} from '@runova/protocol';
import type { GenerationView, RenderJobView, StudioEvent, VideoSession } from '@runova/studio';
import {
  addMediaClip,
  type Clip,
  CONTENT_LANGUAGES,
  type MediaView,
  moveClip,
  type NarrationJobView,
  narrationClip,
  removeClip,
  STYLE_PRESETS,
  type StudioDocument,
  studioAiInputs,
  studioAudioInputs,
  studioInputs,
  type TimelineEdit,
  trimClip,
  updateClip,
  videoLength,
} from '@runova/studio';
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
  | 'voiceEngines'
  | 'voices'
  | 'speak'
  | 'narrationJobs'
  | 'cancelNarration'
  | 'captionScene'
  | 'media'
  | 'cancelRender'
  | 'thumbnail'
>;

export interface ManageStudioDeps {
  service(): StudioParts;
  onEvent(listener: (event: StudioEvent) => void): () => void;
  now(): number;
  files: {
    stat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
    read(path: string, offset: number, length: number): Promise<Uint8Array>;
  };
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
const MAX_VOICES = 200;
const MAX_CLIPS = 400;
const MAX_SCENES = 500;
/** One read, small enough to go through the link without the sender getting ahead of it. */
const MAX_CHUNK = 1024 * 1024;
const DOWNLOAD_IDLE_MS = 10 * 60_000;

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

function sceneList(params: unknown): string[] {
  const value = field(params, 'sceneIds');
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_SCENES ||
    !value.every((one) => typeof one === 'string' && one.length <= 128)
  ) {
    throw new ManageError('bad-params', 'Say which scenes.');
  }
  return value as string[];
}

function flicksOf(params: unknown, name: string): number {
  const value = field(params, name);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ManageError('bad-params', 'That time is not valid.');
  }
  return value;
}

function newClipId(): string {
  return `phone${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function clipLabel(
  clip: Clip,
  names: ReadonlyMap<string, string>,
  titles: ReadonlyMap<string, string>,
): string {
  const source = clip.source;
  if (source.type === 'scene') return titles.get(source.sceneId) ?? 'Scene';
  if (source.type === 'media') return names.get(source.hash) ?? 'Media';
  return source.text;
}

/** Nothing a phone sends can change a track someone locked. */
function assertUnlocked(doc: StudioDocument, trackId: string): void {
  if (doc.timeline.tracks.find((one) => one.id === trackId)?.locked) {
    throw new ManageError('failed', 'That track is locked.');
  }
}

/** Only these gestures, built by Studio's own rules. Never a raw edit from the phone. */
function clipEditOf(
  doc: StudioDocument,
  clip: Clip,
  params: unknown,
  media: readonly MediaView[],
): TimelineEdit | null {
  const kindOf = (hash: string) => media.find((one) => one.hash === hash)?.kind;
  const source = clip.source;
  switch (field(params, 'action')) {
    case 'move':
      return moveClip(doc, clip.id, { start: flicksOf(params, 'start') }, kindOf);
    case 'trim': {
      const edge = field(params, 'edge');
      if (edge !== 'start' && edge !== 'end') throw new ManageError('bad-params', 'Which end?');
      const file = source.type === 'media' ? media.find((one) => one.hash === source.hash) : null;
      return trimClip(doc, clip.id, edge, flicksOf(params, 'to'), file?.duration ?? null);
    }
    case 'set': {
      const patch: { gain?: number; fadeIn?: number; fadeOut?: number } = {};
      for (const key of ['gain', 'fadeIn', 'fadeOut'] as const) {
        const value = field(params, key);
        if (typeof value === 'number' && Number.isFinite(value)) patch[key] = value;
      }
      return updateClip(doc, clip.id, patch, 'Changed a clip');
    }
    case 'remove':
      return removeClip(doc, clip.id, false);
    default:
      throw new ManageError('bad-params', 'That change is not offered.');
  }
}

interface OpenDownload {
  phone: string;
  path: string;
  size: number;
  mtimeMs: number;
  usedAt: number;
}

/**
 * A finished video, pulled by the phone a piece at a time so neither end can be overrun. The path
 * comes from the render's own record and stays here.
 */
export function studioDownloads(deps: ManageStudioDeps): Pick<ManageMethods, 'calls' | 'streams'> {
  const open = new Map<string, OpenDownload>();

  function sweep(): void {
    const oldest = deps.now() - DOWNLOAD_IDLE_MS;
    for (const [id, one] of open) if (one.usedAt < oldest) open.delete(id);
  }

  return {
    calls: {
      'studio.downloadOpen': async (params, context) =>
        saying(async () => {
          sweep();
          const jobId = text(params, 'jobId', 'Say which render.');
          const job = (await deps.service().renderJobs({})).find((one) => one.id === jobId);
          if (!job?.output || job.status !== 'done') {
            throw new ManageError('failed', 'That render has no finished file.');
          }
          const stat = await deps.files.stat(job.output);
          if (!stat) throw new ManageError('failed', 'That file is not on this computer any more.');
          const downloadId = randomUUID();
          open.set(downloadId, {
            phone: context.phone.key,
            path: job.output,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            usedAt: deps.now(),
          });
          return {
            downloadId,
            fileName: basename(job.output),
            bytes: stat.size,
            nonCommercial: job.nonCommercial,
          };
        }),
      'studio.downloadClose': async (params) => {
        open.delete(text(params, 'downloadId', 'Say which download.'));
        return { ok: true, message: '' };
      },
    },
    streams: {
      'studio.downloadRead': async (params, sink, context) => {
        const id = text(params, 'downloadId', 'Say which download.');
        const entry = open.get(id);
        if (!entry || entry.phone !== context.phone.key) {
          throw new ManageError('failed', 'That download has ended. Start it again.');
        }
        const offset = field(params, 'offset');
        const length = field(params, 'length');
        if (
          typeof offset !== 'number' ||
          !Number.isInteger(offset) ||
          offset < 0 ||
          offset > entry.size ||
          typeof length !== 'number' ||
          !Number.isInteger(length) ||
          length <= 0 ||
          length > MAX_CHUNK
        ) {
          throw new ManageError('bad-params', 'That part of the file is not valid.');
        }
        const stat = await deps.files.stat(entry.path);
        if (!stat || stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs) {
          open.delete(id);
          throw new ManageError('failed', 'The file changed. Start the download again.');
        }
        entry.usedAt = deps.now();
        sink.binary(await deps.files.read(entry.path, offset, length));
        sink.end();
        return () => undefined;
      },
    },
  };
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

  function narrationOf(job: NarrationJobView) {
    return { id: job.id, status: job.status, done: job.done, total: job.total, error: job.error };
  }

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

  async function estimateVoice(session: VideoSession, sceneIds: string[], voiceRef: string) {
    const engineId = voiceRef.split(':')[0];
    const engine = (await deps.service().voiceEngines()).find((one) => one.id === engineId);
    if (!engine) throw new ManageError('bad-params', 'Pick an offered voice.');
    const wanted = new Set(sceneIds);
    const chars = session.document.scenario.scenes
      .filter((scene) => wanted.has(scene.id))
      .reduce((sum, scene) => sum + scene.narration.length, 0);
    const price = engine.local ? 0 : engine.pricePerMillionChars;
    return {
      chars,
      usd: price === null ? 0 : Math.round((chars * price) / 100) / 10_000,
      costKnown: price !== null,
    };
  }

  /** One undo step, and it only lands on the version the phone was looking at. */
  async function applyTimeline(videoId: string, params: unknown, edit: TimelineEdit | null) {
    if (!edit) return { ok: true, message: '' };
    const baseSeq = field(params, 'baseSeq');
    if (typeof baseSeq !== 'number') throw new ManageError('bad-params', 'Say which version.');
    const input = studioInputs.apply.safeParse({
      videoId,
      baseSeq,
      ops: edit.ops,
      label: edit.label,
    });
    if (!input.success) throw new ManageError('bad-params', 'That change could not be made.');
    const result = await deps.service().apply(input.data);
    return result.ok
      ? { ok: true, message: edit.label }
      : { ok: false, message: 'The video changed. Look again and retry.' };
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
        const [runs, renders, narrations] = await Promise.all([
          service.generations({ videoId, limit: 5 }),
          service.renderJobs({ videoId }),
          service.narrationJobs({ videoId }),
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
            voiced: narrationClip(session.document, scene.id) !== undefined,
          })),
          language: session.document.language,
          narration: narrations[0] ? narrationOf(narrations[0]) : null,
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

    'studio.voiceEngines': async () =>
      saying(async () =>
        (await deps.service().voiceEngines()).map((engine) => ({
          id: engine.id,
          label: engine.label,
          problem: engine.problem,
          locked: engine.locked,
          local: engine.local,
          nonCommercial: engine.nonCommercial,
        })),
      ),

    'studio.voices': async (params) =>
      saying(async () => {
        const input = studioAudioInputs.voices.safeParse({
          engine: field(params, 'engine'),
          lang: field(params, 'lang'),
        });
        if (!input.success) throw new ManageError('bad-params', 'Pick a voice engine.');
        return (await deps.service().voices(input.data)).slice(0, MAX_VOICES).map((voice) => ({
          id: voice.id,
          label: voice.label,
          ref: `${input.data.engine}:${voice.id}`,
          nonCommercial: voice.nonCommercial === true,
        }));
      }),

    'studio.voiceEstimate': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        const session = await hold(videoId);
        return estimateVoice(session, sceneList(params), text(params, 'voiceRef', 'Pick a voice.'));
      }),

    'studio.speak': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        const session = await hold(videoId);
        const voiceRef = text(params, 'voiceRef', 'Pick a voice.');
        const sceneIds = sceneList(params);
        const input = studioAudioInputs.speak.safeParse({ videoId, sceneIds, voiceRef });
        if (!input.success) throw new ManageError('bad-params', 'Pick an offered voice.');
        const estimate = await estimateVoice(session, sceneIds, voiceRef);
        if (estimate.costKnown) {
          const agreed = field(params, 'confirmedUsd');
          if (typeof agreed !== 'number' || Math.abs(agreed - estimate.usd) > 0.00005) {
            throw new ManageError('failed', 'The price changed. Check it and try again.');
          }
        } else if (field(params, 'acceptUnknownCost') !== true) {
          throw new ManageError('failed', 'This voice has no known price. Agree to that first.');
        }
        await deps.service().speak(input.data);
        return { ok: true, message: 'Speaking the scenes.' };
      }),

    'studio.cancelSpeak': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        await deps
          .service()
          .cancelNarration({ videoId, jobId: text(params, 'jobId', 'Say which run.') });
        return { ok: true, message: 'Stopped.' };
      }),

    'studio.captionScene': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        await hold(videoId);
        await deps
          .service()
          .captionScene({ videoId, sceneId: text(params, 'sceneId', 'Say which scene.') });
        return { ok: true, message: 'Captions added.' };
      }),

    'studio.timeline': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        const session = await hold(videoId);
        const media = await deps.service().media({ videoId });
        const names = new Map(media.map((one) => [one.hash, one.name]));
        const titles = new Map(session.document.scenario.scenes.map((s) => [s.id, s.title]));
        const { tracks, clips } = session.document.timeline;
        return {
          seq: session.status.seq,
          lengthFlicks: videoLength(session.document),
          tracks: tracks.map(({ id, kind, name, muted, solo, locked, volume }) => ({
            id,
            kind,
            name,
            muted,
            solo,
            locked,
            volume,
          })),
          clips: clips.slice(0, MAX_CLIPS).map((clip) => ({
            id: clip.id,
            trackId: clip.trackId,
            start: clip.start,
            duration: clip.duration,
            gain: clip.gain,
            fadeIn: clip.fadeIn,
            fadeOut: clip.fadeOut,
            label: shorten(clipLabel(clip, names, titles), MAX_LINE),
          })),
          truncated: clips.length > MAX_CLIPS,
        };
      }),

    'studio.media': async (params) =>
      saying(async () => {
        const media = await deps.service().media({ videoId: videoRef(params) });
        const kind = field(params, 'kind');
        return media
          .filter((one) => kind === undefined || kind === null || one.kind === kind)
          .slice(0, MAX_CLIPS)
          .map(({ hash, name, kind: type, duration, preparing, problem }) => ({
            hash,
            name,
            kind: type,
            duration,
            preparing,
            problem,
          }));
      }),

    'studio.clipEdit': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        const session = await hold(videoId);
        const clipId = text(params, 'clipId', 'Say which clip.');
        const doc = session.document;
        const clip = doc.timeline.clips.find((one) => one.id === clipId);
        if (!clip) throw new ManageError('failed', 'That clip is not in the video any more.');
        assertUnlocked(doc, clip.trackId);
        const media = await deps.service().media({ videoId });
        const edit = clipEditOf(doc, clip, params, media);
        return applyTimeline(videoId, params, edit);
      }),

    'studio.addMusic': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        const session = await hold(videoId);
        const hash = text(params, 'hash', 'Pick some music.');
        const media = await deps.service().media({ videoId });
        const file = media.find((one) => one.hash === hash && one.kind === 'audio');
        if (!file) throw new ManageError('failed', 'That music is not in this video.');
        const track = session.document.timeline.tracks.find(
          (one) => one.kind === 'music' && !one.locked,
        );
        if (!track) throw new ManageError('failed', 'This video has no music track to add to.');
        const at = field(params, 'at');
        return applyTimeline(
          videoId,
          params,
          addMediaClip(session.document, {
            id: newClipId(),
            trackId: track.id,
            media: { hash, kind: 'audio', duration: file.duration, name: file.name },
            at: typeof at === 'number' ? at : 0,
          }),
        );
      }),

    'studio.trackSet': async (params) =>
      saying(async () => {
        const videoId = videoRef(params);
        const session = await hold(videoId);
        const trackId = text(params, 'trackId', 'Say which track.');
        if (!session.document.timeline.tracks.some((one) => one.id === trackId)) {
          throw new ManageError('failed', 'That track is not in the video any more.');
        }
        const patch: { muted?: boolean; solo?: boolean; volume?: number } = {};
        for (const key of ['muted', 'solo'] as const) {
          const value = field(params, key);
          if (typeof value === 'boolean') patch[key] = value;
        }
        const volume = field(params, 'volume');
        if (typeof volume === 'number') patch.volume = Math.max(0, Math.min(2, volume));
        return applyTimeline(videoId, params, {
          ops: [{ op: 'track.update', trackId, patch }],
          label: 'Changed a track',
        });
      }),

    'studio.cancelRender': async (params) =>
      saying(async () => {
        await deps.service().cancelRender({ jobId: text(params, 'jobId', 'Say which render.') });
        return { ok: true, message: 'Render stopped.' };
      }),
  };
}
