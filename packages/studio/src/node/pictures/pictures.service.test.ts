import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../../api.js';
import type { StudioDocument } from '../../document/schema.js';
import { type FakeGen, GEN_KEY, startFakeGen } from '../../test/fakeGen.js';
import { openNodeSqlite } from '../../test/nodeSqlite.js';
import { pngHeader } from '../../test/png.js';
import { useTempDirs } from '../../test/tempDir.js';
import type { AiRunRequest, AiRunResult } from '../ai/studioAi.js';
import { createStudioService, type StudioHost, type StudioService } from '../service.js';
import type { CaptureRouteInput, StudioCaptureHost } from './pictureJobs.js';

/**
 * The Pictures step through the service (E58): the AI plans the pictures reading the linked
 * project, Studio starts the app and captures the pages, GPT Image makes the rest, files dropped
 * in the pictures folder fill theirs, and the animator gets every ready picture in the scene.
 */

const tempDir = useTempDirs();
const services: StudioService[] = [];
let gen: FakeGen;
beforeAll(async () => {
  gen = await startFakeGen({
    picture: Buffer.from(pngHeader(1536, 1024)),
    clip: Buffer.from(''),
  });
});
afterAll(async () => {
  await gen.close();
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.shutdown()));
});

const SCENARIO = {
  title: 'Shop',
  logline: 'How the shop works.',
  scenes: [
    { title: 'Settings', narration: 'Set it up once.', durationSeconds: 5 },
    { title: 'Done', narration: 'That is all.', durationSeconds: 4 },
  ],
};

const FILES = [
  '```html file:index.html',
  '<img src="pictures/scene-01-settings.png"><div lang="en" dir="ltr">Set it up</div>',
  '```',
].join('\n');

type Reply = (req: AiRunRequest) => AiRunResult;
const answer = (text: string): AiRunResult => ({ ok: true, text, log: '', cliName: 'Claude Code' });

function fakeCapture() {
  const routes: CaptureRouteInput[] = [];
  const started: { folder: string; command: string }[] = [];
  let serving = false;
  const host: StudioCaptureHost = {
    async startApp(input) {
      started.push({ folder: input.folder, command: input.command });
      input.onLine('VITE ready in 300 ms');
      input.onLine('  Local:   http://localhost:5173/');
      serving = true;
      return { url: 'http://localhost:5173/' };
    },
    async stopApp() {
      serving = false;
    },
    probe: async () => serving,
    async captureRoute(input) {
      routes.push(input);
      if (input.url.endsWith('/broken')) throw new Error('The page did not load: 404.');
      return pngHeader(input.width * input.scale, input.height * input.scale);
    },
    listWindows: async () => [],
    captureWindow: async () => pngHeader(800, 600),
    openSignIn: async () => undefined,
  };
  return { host, routes, started, isServing: () => serving };
}

async function setup(replies: Reply[], over: Partial<StudioHost> = {}) {
  const root = await tempDir();
  const projectFolder = join(root, 'shop');
  await mkdir(projectFolder, { recursive: true });
  const requests: AiRunRequest[] = [];
  const events: StudioEvent[] = [];
  const capture = fakeCapture();
  const host: StudioHost = {
    dataDir: join(root, 'userData', 'studio'),
    defaultLibraryRoot: join(root, 'Videos', 'Runova Studio'),
    defaultCacheDir: join(root, 'cache'),
    appDir: join(root, 'app'),
    appId: 'Runova',
    openDb: openNodeSqlite,
    projects: {
      get: (id) =>
        id === 'p1'
          ? {
              id: 'p1',
              name: 'Shop',
              folderPath: projectFolder,
              runCommands: [{ id: 'dev', label: 'dev', command: 'npm run dev' }],
            }
          : null,
    },
    notify: (event) => events.push(event),
    ai: {
      run: async (req) => {
        requests.push(req);
        const reply = replies.shift();
        if (!reply) throw new Error('no scripted reply left');
        return reply(req);
      },
    },
    scenes: {
      check: async () => ({
        ok: true,
        problems: [],
        notes: [],
        thumbnail: null,
        thumbnailPng: null,
      }),
    },
    voice: {
      appKeys: async () => ({ openai: GEN_KEY, gemini: null }),
      secrets: { get: async () => null, set: async () => undefined, isLocked: async () => false },
      fetch,
      baseUrl: gen.url,
    },
    capture: capture.host,
    ...over,
  };
  const service = createStudioService(host);
  services.push(service);
  const video = await service.create({
    title: 'Untitled video',
    projectId: 'p1',
    language: 'en',
    aspect: '16:9',
  });
  await service.open({ videoId: video.id });
  return { service, video, requests, events, capture, projectFolder };
}

const run = { cliId: 'claude-code', model: null, effort: null };

async function settle(service: StudioService, videoId: string, generationId: string) {
  await vi.waitFor(async () => {
    const g = (await service.generations({ videoId, limit: 10 })).find(
      (x) => x.id === generationId,
    );
    expect(g?.status).not.toBe('running');
  });
  return (await service.generations({ videoId, limit: 10 })).find((x) => x.id === generationId)!;
}

async function documentOf(service: StudioService, videoId: string): Promise<StudioDocument> {
  const opened = await service.open({ videoId });
  if (opened.state !== 'open') throw new Error('closed');
  return opened.session.document;
}

/** The scenario, then a Pictures run whose answer is built from the scene ids. */
async function planned(plan: (sceneIds: string[]) => unknown, more: Reply[] = []) {
  let ids: string[] = [];
  const s = await setup([
    () => answer(JSON.stringify(SCENARIO)),
    () => answer(JSON.stringify(plan(ids))),
    ...more,
  ]);
  const scenario = await s.service.startScenario({
    videoId: s.video.id,
    brief: 'The shop',
    targetSeconds: 10,
    styleId: null,
    run,
  });
  await settle(s.service, s.video.id, scenario.id);
  ids = (await documentOf(s.service, s.video.id)).scenario.scenes.map((x) => x.id);
  const g = await s.service.startPictures({ videoId: s.video.id, run });
  const done = await settle(s.service, s.video.id, g.id);
  return { ...s, ids, done };
}

const PLAN = (ids: string[]) => ({
  app: { kind: 'web', runCommandId: 'dev', url: null },
  scenes: [
    {
      sceneId: ids[0],
      pictures: [
        {
          purpose: 'The settings page, pointing at Save.',
          label: 'settings',
          source: 'screenshot',
          shot: { target: 'route', path: '/settings', viewport: 'desktop' },
        },
        {
          purpose: 'A happy shop owner at the counter, from behind.',
          label: 'owner',
          source: 'generate',
          prompt: 'A small shop counter at dawn seen from behind the owner, warm light, no text.',
        },
      ],
    },
    {
      sceneId: ids[1],
      pictures: [
        {
          purpose: 'The team photo.',
          label: 'team',
          source: 'file',
          prompt: 'A photo of the team.',
        },
      ],
    },
  ],
});

describe('the Pictures step', () => {
  it('plans in the project folder, read only, and tells the scenario writer about the project', async () => {
    const s = await planned(PLAN);
    expect(s.done).toMatchObject({ stage: 'pictures', status: 'done' });
    expect(s.requests[0]?.prompt).toContain('The video is about the project "Shop".');
    const request = s.requests[1] as AiRunRequest;
    expect(request.runIn).toBe(s.projectFolder);
    expect(request.prompt).toContain('# Plan the pictures of a video');
    expect(request.pointerPrompt).toContain(join(request.cwd, 'request.md'));
    const doc = await documentOf(s.service, s.video.id);
    expect(doc.scenario.scenes[0]?.pictures?.map((p) => [p.source, p.status])).toEqual([
      ['screenshot', 'planned'],
      ['generate', 'planned'],
    ]);
    const [entry] = await s.service.history({ videoId: s.video.id, limit: 1 });
    expect(entry).toMatchObject({ actor: 'ai', label: 'AI planned 3 pictures' });
    // The AI's choice of run command is kept for the capture.
    const view = await s.service.pictures({ videoId: s.video.id });
    expect(view.app).toMatchObject({ runCommandId: 'dev', status: 'stopped', url: null });
    expect(view).toMatchObject({ engine: 'openai', engineReady: true });
  });

  it('starts the app, captures each page and puts it on its scene', async () => {
    const s = await planned(PLAN);
    await s.service.capturePictures({ videoId: s.video.id });
    await vi.waitFor(async () => {
      const view = await s.service.pictures({ videoId: s.video.id });
      expect(view.job).toMatchObject({ running: false, done: 1, failed: 0 });
    });
    expect(s.capture.started).toEqual([{ folder: s.projectFolder, command: 'npm run dev' }]);
    expect(s.capture.routes[0]).toMatchObject({
      url: 'http://localhost:5173/settings',
      width: 1440,
      height: 900,
      scale: 2,
      partition: 'persist:studio-capture-p1',
    });
    const picture = (await documentOf(s.service, s.video.id)).scenario.scenes[0]?.pictures?.[0];
    expect(picture).toMatchObject({ status: 'ready', error: null });
    const media = await s.service.media({ videoId: s.video.id });
    expect(media.find((m) => m.hash === picture?.mediaHash)).toMatchObject({
      kind: 'image',
      width: 2880,
      height: 1800,
      name: 'Scene 1 - scene-01-settings.png',
    });
    const view = await s.service.pictures({ videoId: s.video.id });
    expect(view.app).toMatchObject({
      status: 'running',
      url: 'http://localhost:5173',
      startedByStudio: true,
    });
    expect(view.app.output).toContain('  Local:   http://localhost:5173/');
    // Closing the video stops the app Studio started.
    await s.service.close({ videoId: s.video.id });
    expect(s.capture.isServing()).toBe(false);
  });

  it('marks a page that fails with why, and keeps going', async () => {
    const s = await planned((ids) => {
      const plan = PLAN(ids);
      plan.scenes[0]!.pictures.unshift({
        purpose: 'A page that is gone.',
        label: 'broken',
        source: 'screenshot',
        shot: { target: 'route', path: '/broken', viewport: 'desktop' },
      });
      return plan;
    });
    await s.service.capturePictures({ videoId: s.video.id });
    await vi.waitFor(async () => {
      const view = await s.service.pictures({ videoId: s.video.id });
      expect(view.job).toMatchObject({ running: false, done: 2, failed: 1 });
    });
    const pictures = (await documentOf(s.service, s.video.id)).scenario.scenes[0]?.pictures ?? [];
    expect(pictures.map((p) => p.status)).toEqual(['failed', 'ready', 'planned']);
    expect(pictures[0]?.error).toBe('The page did not load: 404.');
  });

  it('makes the generated pictures after one confirmation of the whole price', async () => {
    const s = await planned(PLAN);
    const estimate = await s.service.picturesEstimate({ videoId: s.video.id });
    expect(estimate).toMatchObject({ count: 1 });
    await expect(
      s.service.generatePictures({ videoId: s.video.id, confirmedUsd: estimate.usd + 1 }),
    ).rejects.toThrow(/price changed/);
    await s.service.generatePictures({ videoId: s.video.id, confirmedUsd: estimate.usd });
    await vi.waitFor(async () => {
      const doc = await documentOf(s.service, s.video.id);
      expect(doc.scenario.scenes[0]?.pictures?.[1]).toMatchObject({
        status: 'ready',
        genJobId: null,
      });
    });
    const sent = gen.requests.find((r) => r.path === '/v1/images/generations');
    expect(JSON.parse(sent?.body ?? '{}')).toMatchObject({
      size: '1536x1024',
      quality: 'medium',
      prompt: 'A small shop counter at dawn seen from behind the owner, warm light, no text.',
    });
  });

  it('writes PICTURES.md and fills a picture from a file saved under its name', async () => {
    const s = await planned(PLAN);
    const result = await s.service.writePicturesMarkdown({ videoId: s.video.id });
    const text = await readFile(result.markdownPath, 'utf8');
    expect(text).toContain('`scene-02-team.png`');
    const folder = await s.service.picturesFolder({ videoId: s.video.id });
    await writeFile(join(folder, 'scene-02-team.jpg'), Buffer.from(pngHeader(1200, 800)));
    await writeFile(join(folder, 'holiday.png'), Buffer.from(pngHeader(10, 10)));
    const checked = await s.service.checkPicturesFolder({ videoId: s.video.id });
    expect(checked).toMatchObject({ filled: 1, unknown: ['holiday.png'] });
    const team = (await documentOf(s.service, s.video.id)).scenario.scenes[1]?.pictures?.[0];
    expect(team).toMatchObject({ status: 'ready' });
  });

  it('gives the animator the ready pictures as files of the scene, and keeps them through a change', async () => {
    const s = await planned(PLAN, [
      () => answer(FILES),
      () => answer(FILES.replace('Set it up', 'Set it up!')),
    ]);
    await s.service.capturePictures({ videoId: s.video.id });
    await vi.waitFor(async () => {
      expect((await s.service.pictures({ videoId: s.video.id })).job?.running).toBe(false);
    });
    const sceneId = s.ids[0] as string;
    const g = await s.service.startScene({ videoId: s.video.id, sceneId, run });
    expect((await settle(s.service, s.video.id, g.id)).status).toBe('done');
    const request = s.requests.at(-1) as AiRunRequest;
    expect(request.prompt).toContain('## Pictures for this scene');
    expect(request.prompt).toContain(
      '`pictures/scene-01-settings.png` (2880x1800), a screenshot of the real product: The settings page, pointing at Save.',
    );
    expect(request.images).toEqual(['pictures/scene-01-settings.png']);
    const files = async () => {
      const code = await s.service.sceneCode({ videoId: s.video.id, sceneId });
      return code.files.map((f) => f.path).sort();
    };
    expect(await files()).toEqual(['index.html', 'pictures/scene-01-settings.png']);

    const change = await s.service.startScene({
      videoId: s.video.id,
      sceneId,
      instruction: 'Louder title',
      run,
    });
    expect((await settle(s.service, s.video.id, change.id)).status).toBe('done');
    expect(await files()).toEqual(['index.html', 'pictures/scene-01-settings.png']);
  });
});
