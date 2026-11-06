import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { STUDIO_GEN } from '@runova/core';
import { localAppUrl } from '../../ai/pictures/answer.js';
import type {
  CaptureWindowView,
  GenJobView,
  GenRequest,
  PictureEngine,
  PicturesAppView,
  PicturesFolderResult,
  PicturesJobView,
  PicturesView,
  StudioEvent,
} from '../../api.js';
import type { ScenePicture, ShotStep } from '../../document/schema.js';
import { genEstimate } from '../../gen/estimate.js';
import { picturesMarkdown } from '../../pictures/markdown.js';
import {
  findPicture,
  imageAspectFor,
  imageSizeFor,
  PICTURES_DIR,
  PICTURES_MARKDOWN,
  pendingPictures,
  shotViewport,
  updatePictureOp,
} from '../../pictures/pictures.js';
import type { GenJobs } from '../gen/genJobs.js';
import type { MediaLibrary } from '../media/mediaLibrary.js';
import type { VideoStore } from '../project/videoStore.js';

/**
 * The Pictures step's work outside the AI: running the linked project's app, taking the
 * screenshots, sending pictures to the image model, and the pictures folder with its
 * PICTURES.md. A picture that is made goes into the video's media and onto its scene with an
 * edit, so it shows in the history and can be undone like any other change.
 */

export interface CaptureRouteInput {
  /** The browser session the shots are taken in, kept per project so a sign-in lasts. */
  partition: string;
  url: string;
  /** The viewport, in CSS pixels. */
  width: number;
  height: number;
  /** Output pixels per CSS pixel. */
  scale: number;
  theme?: 'light' | 'dark';
  waitFor?: string;
  steps?: ShotStep[];
  timeoutMs: number;
}

/** What the desktop app does for the capture: processes, windows and a browser. */
export interface StudioCaptureHost {
  /**
   * Runs the project's command in its folder. Resolves with the address it printed once it has
   * printed one (or null when it seems up without one), and rejects when it exits first.
   */
  startApp(input: {
    key: string;
    folder: string;
    command: string;
    onLine: (line: string) => void;
    signal: AbortSignal;
  }): Promise<{ url: string | null }>;
  /** Stops a command startApp started, with everything it started. */
  stopApp(key: string): Promise<void>;
  /** True when something answers at the address. */
  probe(url: string): Promise<boolean>;
  captureRoute(input: CaptureRouteInput): Promise<Uint8Array>;
  listWindows(): Promise<CaptureWindowView[]>;
  captureWindow(sourceId: string): Promise<Uint8Array>;
  /** Opens the app in a window the user can sign in with, in the capture's session. */
  openSignIn(input: { partition: string; url: string }): Promise<void>;
}

export interface PicturesProjectInfo {
  id: string;
  name: string;
  folderPath: string;
  runCommands: { id: string; label: string; command: string }[];
}

export interface PictureSettings {
  engine: PictureEngine;
  quality: 'low' | 'medium' | 'high';
  captureScale: 1 | 2;
}

export interface PictureJobsDeps {
  capture?: StudioCaptureHost;
  /** The open video's store; throws when it is not open. */
  store(videoId: string): VideoStore;
  project(videoId: string): Promise<PicturesProjectInfo | null>;
  appConfig(projectId: string): Promise<{ runCommandId: string | null; url: string | null }>;
  saveAppConfig(
    projectId: string,
    patch: { runCommandId?: string | null; url?: string | null },
  ): Promise<void>;
  settings(): Promise<PictureSettings>;
  keys(): Promise<{ openai?: string | null; gemini?: string | null }>;
  media: MediaLibrary;
  gen: GenJobs;
  afterEdit(videoId: string, store: VideoStore): Promise<void>;
  notify(event: StudioEvent): void;
  now(): number;
  /** How long an app may take to answer after it starts. */
  startTimeoutMs?: number;
  pollMs?: number;
}

interface AppState {
  status: PicturesAppView['status'];
  url: string | null;
  startedByStudio: boolean;
  error: string | null;
  output: string[];
  controller: AbortController | null;
  starting: Promise<string> | null;
}

interface Job {
  view: PicturesJobView;
  controller: AbortController;
  done: Promise<void>;
}

const MAX_OUTPUT_LINES = 40;
const SHOT_TIMEOUT_MS = 30_000;
const PICTURE_FILE = /\.(png|jpe?g|webp)$/i;

class Cancelled extends Error {}

/** What the image model is called where the user picks it: GPT Image, or Gemini's. */
export function engineLabel(engine: PictureEngine): string | null {
  if (engine === 'openai') return 'GPT Image';
  if (engine === 'gemini') return STUDIO_GEN.image.gemini.label;
  return null;
}

/** The capture session's name for a project: persistent, so a sign-in is kept. */
export function capturePartition(projectId: string): string {
  return `persist:studio-capture-${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** The address a route shot opens: the app's origin and the shot's path. */
export function routeUrl(base: string, path: string): string {
  const url = new URL(base);
  const clean = path.trim() || '/';
  return new URL(clean.startsWith('/') ? clean : `/${clean}`, url.origin).toString();
}

export function createPictureJobs(deps: PictureJobsDeps) {
  const apps = new Map<string, AppState>();
  const jobs = new Map<string, Job>();
  const watchers = new Map<string, { watcher: FSWatcher; timer: NodeJS.Timeout | null }>();
  const pollMs = deps.pollMs ?? 1000;
  const startTimeoutMs = deps.startTimeoutMs ?? 120_000;

  const changed = (videoId: string) => deps.notify({ type: 'pictures-changed', videoId });

  /** The videos whose Pictures tab has looked at an app, by the project the app belongs to. */
  const viewers = new Map<string, string>();

  /** Every open video of a project hears about its app. */
  const appChanged = (projectId: string, videoId: string) => {
    changed(videoId);
    for (const [other, project] of viewers)
      if (other !== videoId && project === projectId) changed(other);
  };

  function app(projectId: string): AppState {
    let state = apps.get(projectId);
    if (!state) {
      state = {
        status: 'stopped',
        url: null,
        startedByStudio: false,
        error: null,
        output: [],
        controller: null,
        starting: null,
      };
      apps.set(projectId, state);
    }
    return state;
  }

  async function requireProject(videoId: string): Promise<PicturesProjectInfo> {
    const project = await deps.project(videoId);
    if (!project)
      throw new Error('This video belongs to no project, so there is no app to capture.');
    return project;
  }

  function requireCapture(): StudioCaptureHost {
    if (!deps.capture) throw new Error('This copy of Studio cannot take screenshots.');
    return deps.capture;
  }

  async function folder(videoId: string): Promise<string> {
    return join(deps.store(videoId).folder, PICTURES_DIR);
  }

  /** Puts a picture's new state on its scene; does nothing when the picture is gone. */
  async function setPicture(
    videoId: string,
    pictureId: string,
    patch: Partial<Omit<ScenePicture, 'id'>>,
    label: string,
  ): Promise<void> {
    const store = deps.store(videoId);
    const found = findPicture(store.document, pictureId);
    if (!found) return;
    store.apply({
      baseSeq: store.seq,
      ops: [updatePictureOp(found.scene, pictureId, patch)],
      label,
      actor: 'system',
    });
    await deps.afterEdit(videoId, store);
  }

  /** Brings a picture's bytes into the video and marks the picture ready. */
  async function fill(
    videoId: string,
    pictureId: string,
    bytes: Uint8Array,
    label: string,
  ): Promise<void> {
    const store = deps.store(videoId);
    const found = findPicture(store.document, pictureId);
    if (!found) return;
    const name = `Scene ${found.sceneIndex + 1} - ${found.picture.fileName}`;
    const media = await deps.media.importPicture(videoId, store, { bytes, name });
    await setPicture(
      videoId,
      pictureId,
      { status: 'ready', mediaHash: media.hash, error: null, genJobId: null },
      label,
    );
  }

  async function appView(videoId: string): Promise<PicturesAppView> {
    const project = await deps.project(videoId);
    if (!project) {
      return {
        project: null,
        runCommandId: null,
        url: null,
        status: 'stopped',
        startedByStudio: false,
        error: null,
        output: [],
      };
    }
    const config = await deps.appConfig(project.id);
    const state = app(project.id);
    return {
      project: { id: project.id, name: project.name, runCommands: project.runCommands },
      runCommandId: config.runCommandId ?? project.runCommands[0]?.id ?? null,
      url: state.url ?? config.url,
      status: state.status,
      startedByStudio: state.startedByStudio,
      error: state.error,
      output: [...state.output],
    };
  }

  async function waitUntilServing(url: string, signal: AbortSignal): Promise<void> {
    const capture = requireCapture();
    const until = deps.now() + startTimeoutMs;
    while (!(await capture.probe(url))) {
      if (signal.aborted) throw new Cancelled();
      if (deps.now() > until) {
        throw new Error(
          `Nothing answered at ${url} in ${Math.round(startTimeoutMs / 1000)} seconds.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Makes sure the project's app answers, starting it when needed; resolves with its address. */
  async function ensureApp(videoId: string): Promise<string> {
    const project = await requireProject(videoId);
    const capture = requireCapture();
    const state = app(project.id);
    if (state.status === 'running' && state.url) return state.url;
    if (state.starting) return state.starting;
    const config = await deps.appConfig(project.id);
    const known = localAppUrl(config.url);
    const starting = (async () => {
      state.status = 'starting';
      state.error = null;
      state.output = [];
      appChanged(project.id, videoId);
      // One that is already running is used as it is, and left running afterwards.
      if (known && (await capture.probe(known))) {
        Object.assign(state, { status: 'running', url: known, startedByStudio: false });
        appChanged(project.id, videoId);
        return known;
      }
      const commandId = config.runCommandId ?? project.runCommands[0]?.id ?? null;
      const command = project.runCommands.find((c) => c.id === commandId);
      if (!command) {
        throw new Error(
          known
            ? `Nothing answers at ${known}, and the project has no run command to start it. Start the app yourself, or add a run command to the project.`
            : 'The project has no run command. Add one to the project, or start the app yourself and enter its address.',
        );
      }
      const controller = new AbortController();
      state.controller = controller;
      state.startedByStudio = true;
      const started = capture.startApp({
        key: project.id,
        folder: project.folderPath,
        command: command.command,
        signal: controller.signal,
        onLine: (line) => {
          state.output.push(line);
          if (state.output.length > MAX_OUTPUT_LINES) state.output.shift();
          changed(videoId);
        },
      });
      const printed = localAppUrl((await started).url);
      // What the app says beats what was guessed (the AI's plan may name a usual port).
      const url = printed ?? known;
      if (!url) {
        throw new Error(
          'The app started, but Studio could not tell its address. Enter it (like http://localhost:5173) and try again.',
        );
      }
      await waitUntilServing(url, controller.signal);
      if (url !== known) await deps.saveAppConfig(project.id, { url });
      Object.assign(state, { status: 'running', url });
      appChanged(project.id, videoId);
      return url;
    })();
    state.starting = starting;
    try {
      return await starting;
    } catch (error) {
      if (state.startedByStudio) await capture.stopApp(project.id).catch(() => undefined);
      Object.assign(state, {
        status: error instanceof Cancelled ? 'stopped' : 'failed',
        error: error instanceof Cancelled ? null : errorText(error),
        startedByStudio: false,
        url: null,
      });
      appChanged(project.id, videoId);
      throw error;
    } finally {
      state.starting = null;
      state.controller = null;
    }
  }

  async function stopApp(projectId: string, videoId: string | null): Promise<void> {
    const state = apps.get(projectId);
    if (!state) return;
    state.controller?.abort();
    if (state.startedByStudio) await deps.capture?.stopApp(projectId).catch(() => undefined);
    Object.assign(state, { status: 'stopped', url: null, startedByStudio: false, error: null });
    if (videoId) appChanged(projectId, videoId);
  }

  function shotLabel(picture: ScenePicture): string {
    if (picture.shot?.target === 'route') return picture.shot.path || '/';
    return picture.fileName;
  }

  async function runCapture(videoId: string, ids: string[], job: Job): Promise<void> {
    const project = await requireProject(videoId);
    const capture = requireCapture();
    const scale = (await deps.settings()).captureScale;
    const base = await ensureApp(videoId);
    for (const pictureId of ids) {
      if (job.controller.signal.aborted) return;
      const found = findPicture(deps.store(videoId).document, pictureId);
      const shot = found?.picture.shot;
      if (!found || shot?.target !== 'route') continue;
      job.view = { ...job.view, current: { pictureId, label: shotLabel(found.picture) } };
      changed(videoId);
      try {
        const size = shotViewport(shot.viewport);
        const bytes = await capture.captureRoute({
          partition: capturePartition(project.id),
          url: routeUrl(base, shot.path),
          width: size.width,
          height: size.height,
          scale,
          theme: shot.theme,
          waitFor: shot.waitFor,
          steps: shot.steps,
          timeoutMs: SHOT_TIMEOUT_MS,
        });
        if (job.controller.signal.aborted) return;
        await fill(videoId, pictureId, bytes, `Captured ${shotLabel(found.picture)}`);
      } catch (error) {
        if (job.controller.signal.aborted) return;
        job.view = { ...job.view, failed: job.view.failed + 1 };
        await setPicture(
          videoId,
          pictureId,
          { status: 'failed', error: errorText(error) },
          `Could not capture ${shotLabel(found.picture)}`,
        );
      }
      job.view = { ...job.view, done: job.view.done + 1 };
      changed(videoId);
    }
  }

  /** The image requests for these pictures, with what each will cost. */
  async function genRequests(videoId: string, pictureIds?: string[]) {
    const settings = await deps.settings();
    if (settings.engine === 'off') {
      throw new Error(
        'Picture making is off in Settings > Agents > Studio. Write PICTURES.md instead.',
      );
    }
    const engine = settings.engine;
    const doc = deps.store(videoId).document;
    const wanted = pictureIds ? new Set(pictureIds) : null;
    const pending = pendingPictures(
      doc,
      (p) => p.source === 'generate' && !p.genJobId && (!wanted || wanted.has(p.id)),
    );
    return pending.map(({ picture }) => {
      const request: GenRequest =
        engine === 'openai'
          ? {
              kind: 'image',
              engine,
              prompt: picture.prompt || picture.purpose,
              size: imageSizeFor(doc.renderSettings.aspect),
              quality: settings.quality,
            }
          : {
              kind: 'image',
              engine,
              prompt: picture.prompt || picture.purpose,
              size: '1K',
              aspectRatio: imageAspectFor(doc.renderSettings.aspect),
            };
      return { picture, request, estimate: genEstimate(request) };
    });
  }

  async function engineReady(engine: PictureEngine): Promise<boolean> {
    if (engine === 'off') return false;
    const keys = await deps.keys();
    return !!keys[engine]?.trim();
  }

  async function checkFolder(videoId: string): Promise<PicturesFolderResult> {
    const dir = await folder(videoId);
    const markdownPath = join(dir, PICTURES_MARKDOWN);
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((name) => PICTURE_FILE.test(name));
    } catch {
      return { filled: 0, unknown: [], markdownPath };
    }
    const stem = (name: string) => basename(name, extname(name)).toLowerCase();
    const doc = deps.store(videoId).document;
    const all = doc.scenario.scenes.flatMap((s) => s.pictures ?? []);
    const known = new Set(all.map((p) => stem(p.fileName)));
    let filled = 0;
    for (const { picture } of pendingPictures(doc)) {
      const name = names.find((n) => stem(n) === stem(picture.fileName));
      if (!name) continue;
      const file = join(dir, name);
      if (!(await stat(file)).isFile()) continue;
      await fill(
        videoId,
        picture.id,
        await readFile(file),
        `Added ${name} from the pictures folder`,
      );
      filled++;
    }
    return { filled, unknown: names.filter((n) => !known.has(stem(n))), markdownPath };
  }

  /** Fills pictures from files dropped into the folder, a moment after the last change. */
  function watchFolder(videoId: string, dir: string): void {
    if (watchers.has(videoId)) return;
    try {
      const entry = {
        watcher: watch(dir, () => {
          if (entry.timer) clearTimeout(entry.timer);
          entry.timer = setTimeout(() => {
            entry.timer = null;
            void checkFolder(videoId)
              .then((result) => {
                if (result.filled > 0) changed(videoId);
              })
              .catch(() => undefined);
          }, 800);
        }),
        timer: null as NodeJS.Timeout | null,
      };
      entry.watcher.on('error', () => unwatch(videoId));
      watchers.set(videoId, entry);
    } catch {
      // No folder yet, or watching is not possible here; "Check the folder" still works.
    }
  }

  function unwatch(videoId: string): void {
    const entry = watchers.get(videoId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close();
    watchers.delete(videoId);
  }

  return {
    async view(videoId: string): Promise<PicturesView> {
      const settings = await deps.settings();
      const dir = await folder(videoId);
      watchFolder(videoId, dir);
      const app = await appView(videoId);
      if (app.project) viewers.set(videoId, app.project.id);
      return {
        app,
        job: jobs.get(videoId)?.view ?? null,
        engine: settings.engine,
        engineReady: await engineReady(settings.engine),
        engineLabel: engineLabel(settings.engine),
        folder: dir,
      };
    },

    async setApp(
      videoId: string,
      patch: { runCommandId?: string | null; url?: string | null },
    ): Promise<PicturesAppView> {
      const project = await requireProject(videoId);
      const next: { runCommandId?: string | null; url?: string | null } = {};
      if (patch.runCommandId !== undefined) {
        if (patch.runCommandId && !project.runCommands.some((c) => c.id === patch.runCommandId)) {
          throw new Error('That run command is not in the project any more.');
        }
        next.runCommandId = patch.runCommandId;
      }
      if (patch.url !== undefined) {
        const url = patch.url ? localAppUrl(patch.url) : null;
        if (patch.url && !url) {
          throw new Error('Enter a local address, such as http://localhost:5173.');
        }
        next.url = url;
      }
      await deps.saveAppConfig(project.id, next);
      changed(videoId);
      return appView(videoId);
    },

    async startApp(videoId: string): Promise<PicturesAppView> {
      await ensureApp(videoId).catch(() => undefined);
      return appView(videoId);
    },

    async stopApp(videoId: string): Promise<PicturesAppView> {
      const project = await requireProject(videoId);
      await stopApp(project.id, videoId);
      return appView(videoId);
    },

    async signIn(videoId: string): Promise<void> {
      const project = await requireProject(videoId);
      const url = await ensureApp(videoId);
      await requireCapture().openSignIn({ partition: capturePartition(project.id), url });
    },

    /** Starts capturing the route shots; progress comes as pictures-changed events. */
    async capture(videoId: string, pictureIds?: string[]): Promise<PicturesJobView> {
      requireCapture();
      await requireProject(videoId);
      if (jobs.get(videoId)?.view.running) throw new Error('Studio is already capturing.');
      const wanted = pictureIds ? new Set(pictureIds) : null;
      const ids = pendingPictures(
        deps.store(videoId).document,
        (p) =>
          p.source === 'screenshot' && p.shot?.target === 'route' && (!wanted || wanted.has(p.id)),
      ).map((p) => p.picture.id);
      if (ids.length === 0) throw new Error('There are no screenshots of pages left to take.');
      const job: Job = {
        view: { running: true, done: 0, total: ids.length, current: null, failed: 0 },
        controller: new AbortController(),
        done: Promise.resolve(),
      };
      jobs.set(videoId, job);
      job.done = runCapture(videoId, ids, job)
        .catch((error: unknown) => {
          // The app did not start: every shot waits, with why.
          if (job.controller.signal.aborted || error instanceof Cancelled) return;
          job.view = { ...job.view, failed: ids.length - job.view.done };
          void Promise.all(
            ids.map((id) =>
              setPicture(
                videoId,
                id,
                { status: 'failed', error: errorText(error) },
                'Could not capture',
              ).catch(() => undefined),
            ),
          );
        })
        .finally(() => {
          job.view = { ...job.view, running: false, current: null };
          changed(videoId);
        });
      changed(videoId);
      return job.view;
    },

    async cancelCapture(videoId: string): Promise<void> {
      const job = jobs.get(videoId);
      if (!job) return;
      job.controller.abort();
      await job.done;
    },

    windows: () => requireCapture().listWindows(),

    async captureWindow(videoId: string, pictureId: string, sourceId: string): Promise<void> {
      const found = findPicture(deps.store(videoId).document, pictureId);
      if (!found) throw new Error('That picture is not in the video any more.');
      const bytes = await requireCapture().captureWindow(sourceId);
      await fill(videoId, pictureId, bytes, `Captured ${found.picture.fileName}`);
    },

    async generateEstimate(videoId: string, pictureIds?: string[]) {
      const requests = await genRequests(videoId, pictureIds);
      const usd =
        Math.round(requests.reduce((sum, r) => sum + r.estimate.usd, 0) * 10_000) / 10_000;
      const first = requests[0]?.estimate;
      const engine = (await deps.settings()).engine;
      return {
        usd,
        count: requests.length,
        label: engineLabel(engine) ?? '',
        /** Whose account it bills. */
        provider: first?.label ?? '',
        basis: first
          ? `${requests.length} ${requests.length === 1 ? 'picture' : 'pictures'}. ${first.basis}`
          : 'No pictures to make.',
      };
    },

    /** Sends the pictures to the image model; the user confirmed `confirmedUsd` for all of them. */
    async generate(videoId: string, pictureIds: string[] | undefined, confirmedUsd: number) {
      const requests = await genRequests(videoId, pictureIds);
      if (requests.length === 0) throw new Error('There are no pictures left to make.');
      const usd =
        Math.round(requests.reduce((sum, r) => sum + r.estimate.usd, 0) * 10_000) / 10_000;
      if (Math.abs(usd - confirmedUsd) > 0.00005) {
        throw new Error(
          'The price changed since you confirmed it. Look at the estimate and confirm again.',
        );
      }
      const started: GenJobView[] = [];
      for (const { picture, request, estimate } of requests) {
        const job = await deps.gen.start({ videoId, ...request, confirmedUsd: estimate.usd });
        started.push(job);
        await setPicture(
          videoId,
          picture.id,
          { genJobId: job.id, status: 'planned', error: null },
          `Asked ${estimate.label} for ${picture.fileName}`,
        );
      }
      return started;
    },

    /** A generation moved on; the picture that asked for it follows. */
    async genChanged(job: GenJobView): Promise<void> {
      let store: VideoStore;
      try {
        store = deps.store(job.videoId);
      } catch {
        return;
      }
      const found = store.document.scenario.scenes
        .flatMap((scene) => scene.pictures ?? [])
        .find((p) => p.genJobId === job.id);
      if (!found) return;
      if (job.status === 'done' && job.mediaHash) {
        await setPicture(
          job.videoId,
          found.id,
          { status: 'ready', mediaHash: job.mediaHash, genJobId: null, error: null },
          `${job.model} made ${found.fileName}`,
        );
      } else if (job.status !== 'running' && job.status !== 'done') {
        await setPicture(
          job.videoId,
          found.id,
          {
            status: 'failed',
            genJobId: null,
            error: job.error ?? `The picture was ${job.status}.`,
          },
          `${found.fileName} was not made`,
        );
      }
    },

    async writeMarkdown(videoId: string): Promise<PicturesFolderResult> {
      const dir = await folder(videoId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, PICTURES_MARKDOWN), picturesMarkdown(deps.store(videoId).document));
      watchFolder(videoId, dir);
      return { filled: 0, unknown: [], markdownPath: join(dir, PICTURES_MARKDOWN) };
    },

    checkFolder,

    async setFile(videoId: string, pictureId: string, path: string): Promise<void> {
      if (!PICTURE_FILE.test(path)) throw new Error('Pick a PNG, JPEG or WebP picture.');
      await fill(videoId, pictureId, await readFile(path), `Added ${basename(path)}`);
    },

    folder,

    /** The video closed: its capture stops, and an app only it was using is stopped. */
    async videoClosed(
      videoId: string,
      projectId: string | null,
      stillOpen: boolean,
    ): Promise<void> {
      unwatch(videoId);
      viewers.delete(videoId);
      const job = jobs.get(videoId);
      if (job) {
        job.controller.abort();
        await job.done;
        jobs.delete(videoId);
      }
      if (projectId && !stillOpen) await stopApp(projectId, null);
    },

    async shutdown(): Promise<void> {
      for (const videoId of [...watchers.keys()]) unwatch(videoId);
      for (const job of jobs.values()) job.controller.abort();
      await Promise.all([...jobs.values()].map((j) => j.done));
      await Promise.all([...apps.keys()].map((id) => stopApp(id, null)));
    },
  };
}

export type PictureJobs = ReturnType<typeof createPictureJobs>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
