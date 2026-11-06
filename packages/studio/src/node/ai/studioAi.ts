import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EffortLevel } from '@runova/core';
import { type EditMedia, type EditProposal, readEditAnswer } from '../../ai/edit/answer.js';
import { type PicturesPlan, readPicturesAnswer } from '../../ai/pictures/answer.js';
import {
  buildPicturesRequest,
  type PicturesProject,
  picturesPointerPrompt,
} from '../../ai/pictures/prompt.js';
import {
  buildEditRequest,
  buildRepairRequest,
  buildScenarioRequest,
  POINTER_PROMPT,
  REQUEST_FILE,
} from '../../ai/prompts.js';
import {
  type AnswerRead,
  readScenarioAnswer,
  type ScenarioAnswer,
  scenarioToOps,
} from '../../ai/scenario/answer.js';
import { type FencedFile, parseFencedFiles } from '../../ai/scene/files.js';
import {
  buildSceneFixRequest,
  buildSceneRequest,
  type ScenePictureFile,
} from '../../ai/scene/prompt.js';
import type {
  GenerationAttempt,
  GenerationDetail,
  GenerationParams,
  GenerationStage,
  GenerationView,
  RunSettingsInput,
  StartEditInput,
  StartPicturesInput,
  StartScenarioInput,
  StartSceneInput,
  StudioEvent,
} from '../../api.js';
import { type EditOp, OpError } from '../../document/ops.js';
import { DESIGN_SIZES, type StudioDocument, UNTITLED_TITLE } from '../../document/schema.js';
import { PICTURES_DIR, scenePictures } from '../../pictures/pictures.js';
import { sceneConfig } from '../../scenes/config.js';
import { sceneUrl } from '../../scenes/url.js';
import { flicksToSeconds } from '../../time/flicks.js';
import type { EditResult, VideoStore } from '../project/videoStore.js';
import type { SceneCheckResult } from '../scenes/check.js';
import { readTree, treeFromFiles } from '../scenes/codeTree.js';

/**
 * Studio's AI runs: a scenario from a brief, scenario edits from typed instructions, and each
 * scene's motion graphics as code (E33), checked frame by frame before it is used. Each run
 * is a generation record in the video's history with every attempt's request, answer and log kept
 * as blobs, so any result can be traced back to exactly what produced it. The CLI itself is the
 * host's business (`StudioAiHost`); this file decides what to ask, checks what comes back, and
 * repairs a bad answer by sending the problems back up to twice.
 */

export interface AiRunRequest {
  /** Null runs the app's default CLI. */
  cliId: string | null;
  model: string | null;
  effort: EffortLevel | null;
  /** The run's own work folder, holding `request.md`. */
  cwd: string;
  /** The whole request, for CLIs that read their prompt from stdin. */
  prompt: string;
  /** What CLIs that take the prompt as an argument get instead; they read `request.md`. */
  pointerPrompt: string;
  timeoutMs: number;
  /**
   * Where the CLI runs, when not in the work folder: the linked project, which a Pictures run
   * reads (and never changes). The request stays in `cwd`.
   */
  runIn?: string;
  /**
   * Pictures for the CLI to look at, as paths in `cwd`. The host attaches them only for a CLI
   * that can look at images; others run without them.
   */
  images?: string[];
}

export interface AiRunResult {
  ok: boolean;
  /** The CLI's answer (stdout). */
  text: string;
  /** Its progress output (stderr). */
  log: string;
  /** The CLI that ran, by name. */
  cliName: string | null;
  error?: string;
  cancelled?: boolean;
  timedOut?: boolean;
}

export interface StudioAiHost {
  run(
    request: AiRunRequest,
    signal: AbortSignal,
    onLine: (line: string) => void,
  ): Promise<AiRunResult>;
}

/** Checks a scene page in a real browser; the desktop app does it in a hidden offscreen window. */
export interface SceneCheckHost {
  check(input: {
    url: string;
    width: number;
    height: number;
    duration: number;
    fps: number;
  }): Promise<SceneCheckResult & { thumbnailPng: Uint8Array | null }>;
}

export interface StudioAiDeps {
  ai: StudioAiHost | undefined;
  scenes?: SceneCheckHost;
  now: () => number;
  newId: () => string;
  notify: (event: StudioEvent) => void;
  /** The open video's store; throws when the video is not open. */
  store: (videoId: string) => VideoStore;
  /** Called after the AI changed the video, as after any edit. */
  afterEdit: (videoId: string, store: VideoStore) => Promise<void>;
  /** Called when a video's run has ended, however it ended. */
  onIdle?: (videoId: string) => void;
  /** A style's reference scene, shown to the AI as an example. */
  styleReference?: (styleId: string) => Promise<{ path: string; content: Uint8Array }[]>;
  /** The project a video is about, with what a Pictures run needs to know of it. */
  project?: (videoId: string) => Promise<PicturesProject | null>;
  /** The image model pictures can be made with now, or null when the user makes them. */
  imageModel?: () => Promise<string | null>;
  /** Keeps the app a Pictures run worked out (its run command and address) for the capture. */
  onPicturesPlanned?: (videoId: string, app: PicturesPlan['app']) => Promise<void>;
  maxRepairs?: number;
  outputFlushMs?: number;
}

const MINUTE = 60_000;
const BASE_TIMEOUT: Record<GenerationStage, number> = {
  scenario: 10 * MINUTE,
  edit: 5 * MINUTE,
  scene: 20 * MINUTE,
  pictures: 10 * MINUTE,
};
const EFFORT_TIME: Record<EffortLevel, number> = { low: 1, medium: 1, high: 1.5, xhigh: 2, max: 3 };
const MAX_LINES_PER_EVENT = 200;
const MAX_LINE_CHARS = 2000;
export const WORK_DIR = 'work';

interface Job {
  generationId: string;
  controller: AbortController;
  /** Why the run was stopped: by the user, or because the video closed. */
  stopped: 'user' | 'closed' | null;
  done: Promise<void>;
}

interface Plan<T> {
  stage: GenerationStage;
  instruction: string;
  params: GenerationParams;
  run: RunSettingsInput;
  parentId: string | null;
  request: (doc: StudioDocument, store: VideoStore) => string;
  read: (
    text: string,
    doc: StudioDocument,
    store: VideoStore,
  ) => AnswerRead<T> | Promise<AnswerRead<T>>;
  accept: (value: T, store: VideoStore, generationId: string) => Promise<void>;
  /** A fix round's request; the default quotes the answer back with the problems. */
  repair?: (original: string, text: string, issues: string[]) => string;
  /** The folder the CLI runs in instead of the work folder. */
  runIn?: string | null;
  /** Puts files into the work folder before the first round; returns the images among them. */
  prepare?: (workDir: string, store: VideoStore) => Promise<string[]>;
}

/** What a scene run hands over once its code passed the checks. */
interface SceneAnswer {
  treeHash: string;
  thumbnailPng: Uint8Array | null;
}

const TEXT_FILE = /\.(html|js|mjs|css|json|svg|txt)$/i;

/** A scene's ready pictures, as files for its code tree. */
interface ScenePictureBlob extends ScenePictureFile {
  hash: string;
}

function scenePictureBlobs(store: VideoStore, sceneId: string): ScenePictureBlob[] {
  const scene = store.document.scenario.scenes.find((s) => s.id === sceneId);
  if (!scene) return [];
  return scenePictures(scene).flatMap((p) => {
    if (p.status !== 'ready' || !p.mediaHash) return [];
    const media = store.media(p.mediaHash);
    if (!media) return [];
    return [
      {
        path: `${PICTURES_DIR}/${p.fileName}`,
        width: media.info.width,
        height: media.info.height,
        purpose: p.purpose,
        screenshot: p.source === 'screenshot',
        hash: p.mediaHash,
      },
    ];
  });
}

/** The files of a tree that are not text (pictures, fonts), carried into the next version. */
async function binaryFilesOfTree(
  store: VideoStore,
  treeHash: string,
): Promise<{ path: string; hash: string }[]> {
  const manifest = await readTree(store.blobs, treeHash);
  return manifest.files.filter((f) => !TEXT_FILE.test(f.path));
}

/** The video's imported files, as edits by typing name them. */
function editMedia(store: VideoStore): EditMedia[] {
  return store
    .mediaList()
    .map((m) => ({ hash: m.hash, name: m.name, kind: m.kind, duration: m.info.duration }));
}

/** The text files of a tree, for showing the current code to the AI when changing a scene. */
async function filesOfTree(store: VideoStore, treeHash: string): Promise<FencedFile[]> {
  const manifest = await readTree(store.blobs, treeHash);
  const files: FencedFile[] = [];
  for (const file of manifest.files) {
    if (TEXT_FILE.test(file.path))
      files.push({ path: file.path, content: await store.blobs.text(file.hash) });
  }
  return files;
}

export function createStudioAi(deps: StudioAiDeps) {
  const jobs = new Map<string, Job>();
  const maxRepairs = deps.maxRepairs ?? 2;

  const changed = (videoId: string, generationId: string) =>
    deps.notify({ type: 'generation-changed', videoId, generationId });

  /** Batches a run's output lines so a chatty CLI cannot flood the UI with events. */
  function outputStream(videoId: string, generationId: string) {
    let pending: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (pending.length === 0) return;
      const lines = pending.slice(-MAX_LINES_PER_EVENT);
      pending = [];
      deps.notify({ type: 'generation-output', videoId, generationId, lines });
    };
    return {
      push(line: string) {
        pending.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line);
        timer ??= setTimeout(flush, deps.outputFlushMs ?? 250);
      },
      flush,
    };
  }

  async function execute<T>(videoId: string, job: Job, plan: Plan<T>): Promise<void> {
    const store = deps.store(videoId);
    const id = job.generationId;
    const ai = deps.ai as StudioAiHost;
    const output = outputStream(videoId, id);
    const workDir = join(store.folder, WORK_DIR, id);
    const attempts: GenerationAttempt[] = [];
    const finish = (patch: Parameters<VideoStore['updateGeneration']>[1]) =>
      store.updateGeneration(id, { ...patch, finishedAt: deps.now() });
    const effort = plan.run.effort ?? null;
    const timeoutMs = BASE_TIMEOUT[plan.stage] * (effort ? EFFORT_TIME[effort] : 1);

    try {
      await mkdir(workDir, { recursive: true });
      const images = plan.prepare ? await plan.prepare(workDir, store) : [];
      const original = plan.request(store.document, store);
      let request = original;
      for (let round = 0; round <= maxRepairs; round++) {
        await writeFile(join(workDir, REQUEST_FILE), request, 'utf8');
        const attempt: GenerationAttempt = {
          requestHash: await store.blobs.put(request),
          outputHash: null,
          logHash: null,
          startedAt: deps.now(),
          finishedAt: null,
          issues: [],
          error: null,
        };
        attempts.push(attempt);
        store.updateGeneration(id, { attempts });
        changed(videoId, id);

        // A cancel that lands while the request is being written has no run to stop yet.
        const result = job.controller.signal.aborted
          ? { ok: false, text: '', log: '', cliName: null, cancelled: true }
          : await ai.run(
              {
                cliId: plan.run.cliId,
                model: plan.run.model ?? null,
                effort,
                cwd: workDir,
                prompt: request,
                pointerPrompt: plan.runIn
                  ? picturesPointerPrompt(join(workDir, REQUEST_FILE))
                  : POINTER_PROMPT,
                timeoutMs,
                ...(plan.runIn ? { runIn: plan.runIn } : {}),
                ...(images.length > 0 ? { images } : {}),
              },
              job.controller.signal,
              output.push,
            );
        output.flush();
        attempt.finishedAt = deps.now();
        if (result.text) attempt.outputHash = await store.blobs.put(result.text);
        if (result.log) attempt.logHash = await store.blobs.put(result.log);
        const cliName = result.cliName ?? null;

        if (result.cancelled || job.controller.signal.aborted) {
          finish({
            attempts,
            cliName,
            status: job.stopped === 'closed' ? 'interrupted' : 'cancelled',
          });
          return;
        }
        if (!result.ok) {
          attempt.error = result.error ?? 'The CLI did not answer.';
          finish({ attempts, cliName, status: 'failed', error: attempt.error });
          return;
        }
        const read = await plan.read(result.text, store.document, store);
        if (read.ok) {
          // Everything in the work folder is in the blobs by now.
          await rm(workDir, { recursive: true, force: true });
          store.updateGeneration(id, { attempts, cliName });
          await plan.accept(read.value, store, id);
          return;
        }
        attempt.issues = read.issues;
        if (round === maxRepairs) {
          finish({
            attempts,
            cliName,
            status: 'failed',
            error: `The answer still did not fit after ${maxRepairs} repair rounds: ${read.issues[0]}`,
          });
          return;
        }
        store.updateGeneration(id, { attempts, cliName });
        output.push(`The answer did not fit (${read.issues[0]}). Asking for a fix...`);
        request = (plan.repair ?? buildRepairRequest)(original, result.text, read.issues);
      }
    } catch (error) {
      finish({
        attempts,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      output.flush();
    }
  }

  async function start<T>(videoId: string, plan: Plan<T>): Promise<GenerationView> {
    const store = deps.store(videoId);
    if (!deps.ai) throw new Error('This copy of Studio cannot run AI CLIs.');
    const busy = jobs.get(videoId);
    if (busy) {
      // A run records its outcome a moment before it lets go of the video; only a live one blocks.
      if (store.generation(busy.generationId)?.status === 'running') {
        throw new Error('An AI run is already working on this video. Wait for it or cancel it.');
      }
      await busy.done;
    }
    const id = deps.newId();
    store.addGeneration({
      id,
      parentId: plan.parentId,
      stage: plan.stage,
      status: 'running',
      cliId: plan.run.cliId,
      cliName: null,
      model: plan.run.model ?? null,
      effort: plan.run.effort ?? null,
      instruction: plan.instruction,
      params: plan.params,
      startedAt: deps.now(),
    });
    const job: Job = {
      generationId: id,
      controller: new AbortController(),
      stopped: null,
      done: Promise.resolve(),
    };
    jobs.set(videoId, job);
    // execute() records its own failures; a store closed under it (a crash) has nowhere to write.
    job.done = execute(videoId, job, plan)
      .catch(() => undefined)
      .finally(() => {
        jobs.delete(videoId);
        changed(videoId, id);
        deps.onIdle?.(videoId);
      });
    changed(videoId, id);
    return store.generation(id) as GenerationView;
  }

  /** The project a video is about, by name, for the scenario writer. */
  async function projectName(videoId: string): Promise<string | null> {
    return deps.project ? ((await deps.project(videoId))?.name ?? null) : null;
  }

  function scenarioPlan(
    input: Omit<StartScenarioInput, 'videoId'>,
    parentId: string | null,
    project: string | null,
  ): Plan<ScenarioAnswer> {
    return {
      stage: 'scenario',
      instruction: input.brief,
      params: {
        targetSeconds: input.targetSeconds,
        styleId: input.styleId,
        ...(input.customStyle ? { customStyle: input.customStyle } : {}),
      },
      run: input.run,
      parentId,
      request: (doc) =>
        buildScenarioRequest({
          brief: input.brief,
          document: doc,
          targetSeconds: input.targetSeconds,
          styleId: input.styleId,
          customStyle: input.customStyle,
          projectName: project,
        }),
      read: (text, doc) => readScenarioAnswer(text, doc.language),
      accept: async (answer, store, generationId) => {
        const doc = store.document;
        const ops: EditOp[] = [];
        // A preset and a custom style never both hold: picking one clears the other.
        if (input.styleId !== null && input.styleId !== doc.styleId) {
          ops.push({ op: 'doc.set', field: 'styleId', value: input.styleId });
        }
        if (input.styleId !== null && doc.customStyle) {
          ops.push({ op: 'doc.set', field: 'customStyle', value: null });
        }
        if (input.customStyle && input.customStyle !== doc.customStyle) {
          ops.push({ op: 'doc.set', field: 'customStyle', value: input.customStyle });
        }
        if (input.customStyle && doc.styleId !== null) {
          ops.push({ op: 'doc.set', field: 'styleId', value: null });
        }
        ops.push(
          ...scenarioToOps(doc, answer, deps.newId, { keepTitle: doc.title !== UNTITLED_TITLE }),
        );
        const result = store.apply({
          baseSeq: store.seq,
          ops,
          label: 'AI wrote the scenario',
          actor: 'ai',
          generationId,
        });
        store.updateGeneration(generationId, {
          status: 'done',
          resultSeq: result.seq,
          finishedAt: deps.now(),
        });
        await deps.afterEdit(store.manifest.id, store);
      },
    };
  }

  function editPlan(
    input: Omit<StartEditInput, 'videoId'>,
    parentId: string | null,
  ): Plan<EditProposal> {
    return {
      stage: 'edit',
      instruction: input.instruction,
      params: {},
      run: input.run,
      parentId,
      request: (doc, store) =>
        buildEditRequest({
          instruction: input.instruction,
          document: doc,
          media: editMedia(store),
        }),
      read: (text, doc, store) =>
        readEditAnswer(text, doc, deps.newId, { media: editMedia(store) }),
      accept: async (proposal, store, generationId) => {
        store.updateGeneration(generationId, {
          status: 'proposed',
          proposal: { ...proposal, baseSeq: store.seq },
          finishedAt: deps.now(),
        });
        // Only the newest proposal waits; an older one would be offered again once this one goes.
        store.discardProposals(generationId);
      },
    };
  }

  function scenePlan(
    input: Omit<StartSceneInput, 'videoId'>,
    parentId: string | null,
    current: FencedFile[] | undefined,
    example: FencedFile[] | undefined,
    pictures: ScenePictureBlob[],
    carried: { path: string; hash: string }[],
  ): Plan<SceneAnswer> {
    let lastFiles: FencedFile[] = [];
    return {
      // A CLI that can look at pictures sees the scene's, to know where to point.
      prepare: async (workDir, store) => {
        if (pictures.length === 0) return [];
        await mkdir(join(workDir, PICTURES_DIR), { recursive: true });
        for (const picture of pictures) {
          await copyFile(store.blobs.path(picture.hash), join(workDir, picture.path));
        }
        return pictures.map((p) => p.path);
      },
      stage: 'scene',
      instruction: input.instruction ?? 'Animate this scene.',
      params: { sceneId: input.sceneId },
      run: input.run,
      parentId,
      request: (doc) =>
        buildSceneRequest({
          document: doc,
          sceneId: input.sceneId,
          instruction: input.instruction,
          current,
          example,
          pictures,
        }),
      read: async (text, doc) => {
        const files = parseFencedFiles(text);
        if (files.length === 0) {
          return {
            ok: false,
            issues: [
              'The answer has no files. Put each file in a fenced block with its name on the fence line, like ```html file:index.html.',
            ],
          };
        }
        lastFiles = files;
        const scene = doc.scenario.scenes.find((s) => s.id === input.sceneId);
        if (!scene) throw new Error('That scene is not in the video any more.');
        const store = deps.store(doc.id);
        // Studio's files go last, so the answer can never replace a picture with its own.
        const ours = new Set(pictures.map((p) => p.path));
        const extra = [
          ...carried.filter((f) => !ours.has(f.path) && !f.path.startsWith(`${PICTURES_DIR}/`)),
          ...pictures,
        ];
        const added = await Promise.all(
          extra.map(async (f) => ({
            path: f.path,
            content: new Uint8Array(await store.blobs.bytes(f.hash)),
          })),
        );
        let tree: Awaited<ReturnType<typeof treeFromFiles>>;
        try {
          tree = await treeFromFiles(
            [...files.filter((f) => !ours.has(f.path.replace(/^\.\//, ''))), ...added],
            store.blobs,
          );
        } catch (error) {
          return { ok: false, issues: [error instanceof Error ? error.message : String(error)] };
        }
        const size = DESIGN_SIZES[doc.renderSettings.aspect];
        const duration = flicksToSeconds(scene.targetDuration);
        const checked = await (deps.scenes as SceneCheckHost).check({
          url: sceneUrl(tree.treeHash, sceneConfig(doc, scene)),
          width: size.width,
          height: size.height,
          duration,
          fps: doc.renderSettings.fps,
        });
        if (!checked.ok) return { ok: false, issues: checked.problems.slice(0, 20) };
        return { ok: true, value: { treeHash: tree.treeHash, thumbnailPng: checked.thumbnailPng } };
      },
      repair: (original, _text, issues) => buildSceneFixRequest(original, lastFiles, issues),
      accept: async (answer, store, generationId) => {
        const position = store.document.scenario.scenes.findIndex((s) => s.id === input.sceneId);
        const result = store.setSceneCode({
          sceneId: input.sceneId,
          treeHash: answer.treeHash,
          author: 'ai',
          label: input.instruction
            ? `AI changed the animation of scene ${position + 1}`
            : `AI animated scene ${position + 1}`,
          generationId,
        });
        if (answer.thumbnailPng) {
          store.setThumbnail(answer.treeHash, await store.blobs.put(answer.thumbnailPng));
        }
        await store.mirrorScene(input.sceneId);
        store.updateGeneration(generationId, {
          status: 'done',
          resultSeq: result.seq,
          finishedAt: deps.now(),
        });
        await deps.afterEdit(store.manifest.id, store);
      },
    };
  }

  async function startScene(
    videoId: string,
    input: Omit<StartSceneInput, 'videoId'>,
    parentId: string | null,
  ): Promise<GenerationView> {
    if (!deps.scenes) throw new Error('This copy of Studio cannot check scenes.');
    const store = deps.store(videoId);
    const scene = store.document.scenario.scenes.find((s) => s.id === input.sceneId);
    if (!scene) throw new Error('That scene is not in the video any more.');
    const current =
      input.instruction && scene.code.treeHash
        ? await filesOfTree(store, scene.code.treeHash)
        : undefined;
    const example =
      store.document.styleId && deps.styleReference
        ? await deps
            .styleReference(store.document.styleId)
            .then((files) =>
              files
                .filter((f) => TEXT_FILE.test(f.path))
                .map((f) => ({ path: f.path, content: Buffer.from(f.content).toString('utf8') })),
            )
            .catch(() => undefined)
        : undefined;
    // A change keeps the files the code has besides its text: fonts, models, and its pictures.
    const carried =
      input.instruction && scene.code.treeHash
        ? await binaryFilesOfTree(store, scene.code.treeHash)
        : [];
    const pictures = scenePictureBlobs(store, input.sceneId);
    return start(videoId, scenePlan(input, parentId, current, example, pictures, carried));
  }

  async function picturesPlan(
    videoId: string,
    input: Omit<StartPicturesInput, 'videoId'>,
    parentId: string | null,
  ): Promise<Plan<PicturesPlan>> {
    const project = deps.project ? await deps.project(videoId) : null;
    const imageModel = deps.imageModel ? await deps.imageModel() : null;
    const options = { hasProject: project !== null, canGenerate: imageModel !== null };
    return {
      stage: 'pictures',
      instruction: input.instruction ?? 'Plan the pictures.',
      params: {},
      run: input.run,
      parentId,
      runIn: project?.folderPath ?? null,
      request: (doc) =>
        buildPicturesRequest({
          document: doc,
          project,
          imageModel,
          instruction: input.instruction,
        }),
      read: (text, doc) => readPicturesAnswer(text, doc, { ...options, newId: deps.newId }),
      accept: async (plan, store, generationId) => {
        let resultSeq: number | null = null;
        if (plan.ops.length > 0) {
          resultSeq = store.apply({
            baseSeq: store.seq,
            ops: plan.ops,
            label:
              plan.count === 0
                ? 'AI found no pictures to add'
                : `AI planned ${plan.count} ${plan.count === 1 ? 'picture' : 'pictures'}`,
            actor: 'ai',
            generationId,
          }).seq;
        }
        if (project) await deps.onPicturesPlanned?.(videoId, plan.app);
        store.updateGeneration(generationId, {
          status: 'done',
          resultSeq,
          finishedAt: deps.now(),
        });
        await deps.afterEdit(store.manifest.id, store);
      },
    };
  }

  async function startPictures(
    videoId: string,
    input: Omit<StartPicturesInput, 'videoId'>,
    parentId: string | null,
  ): Promise<GenerationView> {
    const store = deps.store(videoId);
    if (store.document.scenario.scenes.length === 0) {
      throw new Error('Write the scenario first; pictures are planned scene by scene.');
    }
    return start(videoId, await picturesPlan(videoId, input, parentId));
  }

  function proposed(videoId: string, generationId: string) {
    const store = deps.store(videoId);
    const generation = store.generation(generationId);
    if (generation?.status !== 'proposed' || !generation.proposal) {
      throw new Error('That proposal is no longer waiting to be applied.');
    }
    return { store, generation, proposal: generation.proposal };
  }

  async function stop(videoId: string, reason: 'user' | 'closed'): Promise<void> {
    const job = jobs.get(videoId);
    if (!job) return;
    job.stopped = reason;
    job.controller.abort();
    await job.done;
  }

  return {
    startScenario: async ({ videoId, ...input }: StartScenarioInput) =>
      start(videoId, scenarioPlan(input, null, await projectName(videoId))),

    startEdit: ({ videoId, ...input }: StartEditInput) => start(videoId, editPlan(input, null)),

    startScene: ({ videoId, ...input }: StartSceneInput) => startScene(videoId, input, null),

    startPictures: ({ videoId, ...input }: StartPicturesInput) =>
      startPictures(videoId, input, null),

    /** Runs a finished generation again with the same request and AI picks, as a new record. */
    async retry({ videoId, generationId }: { videoId: string; generationId: string }) {
      const old = deps.store(videoId).generation(generationId);
      if (!old) throw new Error('That AI run is not in this video.');
      if (old.status === 'running') throw new Error('That AI run is still working.');
      const run = { cliId: old.cliId, model: old.model, effort: old.effort };
      if (old.stage === 'scene') {
        const sceneId = old.params.sceneId ?? '';
        const instruction = old.instruction === 'Animate this scene.' ? undefined : old.instruction;
        return startScene(videoId, { sceneId, instruction, run }, old.id);
      }
      if (old.stage === 'edit')
        return start(videoId, editPlan({ instruction: old.instruction, run }, old.id));
      if (old.stage === 'pictures') {
        const instruction = old.instruction === 'Plan the pictures.' ? undefined : old.instruction;
        return startPictures(videoId, { instruction, run }, old.id);
      }
      return start(
        videoId,
        scenarioPlan(
          {
            brief: old.instruction,
            targetSeconds: old.params.targetSeconds ?? 60,
            styleId: old.params.styleId ?? null,
            customStyle: old.params.customStyle ?? null,
            run,
          },
          old.id,
          await projectName(videoId),
        ),
      );
    },

    async cancel({ videoId, generationId }: { videoId: string; generationId: string }) {
      if (jobs.get(videoId)?.generationId === generationId) await stop(videoId, 'user');
    },

    /** Stops the video's run before the video closes; it is recorded as interrupted. */
    stopForClose: (videoId: string) => stop(videoId, 'closed'),

    isRunning: (videoId: string) => jobs.has(videoId),

    generations: ({ videoId, limit }: { videoId: string; limit: number }) =>
      deps.store(videoId).generations({ limit }),

    async detail({
      videoId,
      generationId,
    }: {
      videoId: string;
      generationId: string;
    }): Promise<GenerationDetail> {
      const store = deps.store(videoId);
      const generation = store.generation(generationId);
      if (!generation) throw new Error('That AI run is not in this video.');
      const read = (hash: string | null) => (hash ? store.blobs.text(hash) : Promise.resolve(null));
      const texts = await Promise.all(
        generation.attempts.map(async (a) => ({
          request: await store.blobs.text(a.requestHash),
          output: await read(a.outputHash),
          log: await read(a.logHash),
        })),
      );
      return { ...generation, texts };
    },

    async applyProposal({
      videoId,
      generationId,
    }: {
      videoId: string;
      generationId: string;
    }): Promise<EditResult> {
      const { store, proposal } = proposed(videoId, generationId);
      let result: EditResult;
      try {
        result = store.apply({
          baseSeq: store.seq,
          ops: proposal.ops,
          label: `AI: ${proposal.summary}`.slice(0, 300),
          actor: 'ai',
          generationId,
        });
      } catch (error) {
        if (error instanceof OpError) {
          throw new Error(
            'The scenario changed since this was proposed, so it no longer fits. Ask again.',
          );
        }
        throw error;
      }
      store.updateGeneration(generationId, { status: 'applied', resultSeq: result.seq });
      store.discardProposals(null);
      await deps.afterEdit(videoId, store);
      changed(videoId, generationId);
      return result;
    },

    async discardProposal({ videoId, generationId }: { videoId: string; generationId: string }) {
      const { store } = proposed(videoId, generationId);
      store.updateGeneration(generationId, { status: 'discarded' });
      changed(videoId, generationId);
    },

    async shutdown() {
      await Promise.all([...jobs.keys()].map((videoId) => stop(videoId, 'closed')));
    },

    /** Forgets a video's run without waiting, as a crash would. Tests only. */
    abandonForTest(videoId: string) {
      const job = jobs.get(videoId);
      if (!job) return;
      jobs.delete(videoId);
      job.stopped = 'closed';
    },
  };
}

export type StudioAi = ReturnType<typeof createStudioAi>;

export { sceneConfig } from '../../scenes/config.js';
