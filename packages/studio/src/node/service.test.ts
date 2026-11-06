import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../api.js';
import { createScene } from '../document/schema.js';
import { openNodeSqlite } from '../test/nodeSqlite.js';
import { useTempDirs } from '../test/tempDir.js';
import { BlobStore } from './blobs/blobStore.js';
import { treeFromFiles } from './scenes/codeTree.js';
import { createStudioService, type StudioHost, type StudioService } from './service.js';

const tempDir = useTempDirs();
const services: StudioService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.shutdown()));
});

interface Setup {
  base: string;
  service: StudioService;
  host: StudioHost;
  events: StudioEvent[];
  projectFolder: string;
}

let clock = 1_700_000_000_000;

async function setup(over: Partial<StudioHost> = {}, base?: string): Promise<Setup> {
  const root = base ?? (await tempDir());
  const projectFolder = join(root, 'code', 'shop-app');
  await mkdir(projectFolder, { recursive: true });
  const events: StudioEvent[] = [];
  const host: StudioHost = {
    dataDir: join(root, 'userData', 'studio'),
    defaultLibraryRoot: join(root, 'Videos', 'Runova Studio'),
    defaultCacheDir: join(root, 'userData', 'studio-cache'),
    appDir: join(root, 'app'),
    appId: 'Runova',
    openDb: openNodeSqlite,
    projects: {
      get: (id) => (id === 'p1' ? { id: 'p1', name: 'Shop App', folderPath: projectFolder } : null),
    },
    notify: (event) => events.push(event),
    now: () => clock++,
    pid: process.pid,
    hostname: 'laptop',
    ...over,
  };
  const service = createStudioService(host);
  services.push(service);
  return { base: root, service, host, events, projectFolder };
}

const newVideo = (s: StudioService, projectId: string | null = null, title = 'Launch film') =>
  s.create({ title, projectId, language: 'fa', aspect: '16:9' });

async function openSession(s: StudioService, videoId: string) {
  const result = await s.open({ videoId });
  if (result.state !== 'open') throw new Error(`expected open, got ${result.state}`);
  return result.session;
}

describe('settings and storage folders', () => {
  it('uses the Studio library under Videos and a local cache by default', async () => {
    const { service, host } = await setup();
    expect(await service.settings()).toEqual({
      defaultRoot: host.defaultLibraryRoot,
      defaultRootIsCustom: false,
      standaloneRoot: join(host.defaultLibraryRoot, 'Standalone'),
      cacheDir: host.defaultCacheDir,
      cacheCapGb: 20,
      autoResumeRenders: true,
      hwEncode: true,
    });
  });

  it('gives each project its own folder in the library until the user picks another', async () => {
    const { service, host } = await setup();
    const storage = await service.projectStorage({ projectId: 'p1' });
    expect(storage).toMatchObject({
      root: join(host.defaultLibraryRoot, 'Projects', 'Shop-App'),
      isCustom: false,
      check: { ok: true },
    });
  });

  it('refuses a project folder inside the project source, and keeps the old one', async () => {
    const { service, projectFolder } = await setup();
    await expect(
      service.setProjectRoot({ projectId: 'p1', path: join(projectFolder, 'videos') }),
    ).rejects.toThrow(/inside the project/);
    expect((await service.projectStorage({ projectId: 'p1' })).isCustom).toBe(false);
  });

  it('saves a project folder the user picked, and resets it on request', async () => {
    const { service, base } = await setup();
    const chosen = join(base, 'Media', 'Shop videos');
    const saved = await service.setProjectRoot({ projectId: 'p1', path: chosen });
    expect(saved).toMatchObject({ root: chosen, isCustom: true });
    const reset = await service.setProjectRoot({ projectId: 'p1', path: null });
    expect(reset.isCustom).toBe(false);
  });

  it('refuses a folder for a project it does not know', async () => {
    const { service } = await setup();
    await expect(service.projectStorage({ projectId: 'ghost' })).rejects.toThrow(/project/);
  });

  it('checks a folder the user is typing, against the project when there is one', async () => {
    const { service, projectFolder, base } = await setup();
    const inside = await service.checkRoot({ path: join(projectFolder, 'v'), projectId: 'p1' });
    expect(inside.ok).toBe(false);
    const outside = await service.checkRoot({ path: join(base, 'elsewhere'), projectId: null });
    expect(outside.ok).toBe(true);
  });

  it('changes the library folder only to one that passes the checks', async () => {
    const { service, host, base } = await setup();
    await expect(
      service.updateSettings({ defaultRoot: join(host.appDir as string, 'x') }),
    ).rejects.toThrow(/Runova's own folder/);
    const next = await service.updateSettings({ defaultRoot: join(base, 'Lib'), cacheCapGb: 50 });
    expect(next).toMatchObject({
      defaultRoot: join(base, 'Lib'),
      defaultRootIsCustom: true,
      cacheCapGb: 50,
    });
  });

  it('drops the folders of projects that were removed from Runova', async () => {
    const { service, base } = await setup();
    await service.setProjectRoot({ projectId: 'p1', path: join(base, 'Media') });
    await service.pruneProjects(new Set());
    expect((await service.projectStorage({ projectId: 'p1' })).isCustom).toBe(false);
  });
});

describe('creating and listing videos', () => {
  it('puts a standalone video in the library and a project video in the project folder', async () => {
    const { service, host } = await setup();
    const standalone = await newVideo(service);
    const forProject = await newVideo(service, 'p1', 'Shop teaser');
    expect(standalone.folder.startsWith(join(host.defaultLibraryRoot, 'Standalone'))).toBe(true);
    expect(
      forProject.folder.startsWith(join(host.defaultLibraryRoot, 'Projects', 'Shop-App')),
    ).toBe(true);
    expect(forProject.linkedProjectId).toBe('p1');
  });

  it('lists videos newest first, filtered by project or standalone', async () => {
    const { service } = await setup();
    const a = await newVideo(service, null, 'A');
    const b = await newVideo(service, 'p1', 'B');
    expect((await service.list()).map((v) => v.id)).toEqual([b.id, a.id]);
    expect((await service.list({ projectId: 'p1' })).map((v) => v.id)).toEqual([b.id]);
    expect((await service.list({ projectId: null })).map((v) => v.id)).toEqual([a.id]);
  });

  it('keeps the order the user dragged the videos into, with pinned ones on top', async () => {
    const { service, events } = await setup();
    const a = await newVideo(service, null, 'A');
    const b = await newVideo(service, 'p1', 'B');
    const c = await newVideo(service, null, 'C');
    const ids = async (input?: { projectId?: string | null }) =>
      (await service.list(input)).map((v) => v.id);
    expect(await ids()).toEqual([c.id, b.id, a.id]);

    const changed = events.length;
    await service.reorder({ videoIds: [a.id, c.id, b.id] });
    expect(await ids()).toEqual([a.id, c.id, b.id]);
    expect(events.slice(changed)).toContainEqual({ type: 'library-changed' });
    // A filtered list keeps the same order among the videos it shows.
    expect(await ids({ projectId: null })).toEqual([a.id, c.id]);

    // Reordering what a filter shows leaves the hidden videos where they were, after them.
    await service.reorder({ videoIds: [c.id, a.id] });
    expect(await ids()).toEqual([c.id, a.id, b.id]);

    // A new video goes on top of the order; a pinned one above everything.
    const d = await newVideo(service, null, 'D');
    expect(await ids()).toEqual([d.id, c.id, a.id, b.id]);
    await service.setPinned({ videoId: b.id, pinned: true });
    expect(await ids()).toEqual([b.id, d.id, c.id, a.id]);
    expect((await service.list())[0]).toMatchObject({ id: b.id, pinned: true });
    await service.setPinned({ videoId: b.id, pinned: false });
    expect(await ids()).toEqual([d.id, c.id, a.id, b.id]);

    // Unknown and repeated ids are ignored rather than saved.
    await service.reorder({ videoIds: ['nope', a.id, a.id] });
    expect(await ids()).toEqual([a.id, d.id, c.id, b.id]);
  });

  it('marks a video whose folder disappeared', async () => {
    const { service } = await setup();
    const video = await newVideo(service);
    await rm(video.folder, { recursive: true });
    expect((await service.list())[0]).toMatchObject({ id: video.id, missing: true });
    expect(await service.open({ videoId: video.id })).toMatchObject({ state: 'missing' });
  });

  it('refuses to create a project video when the project folder setting points inside the project', async () => {
    const { service, projectFolder, host } = await setup();
    const { writeFile } = await import('node:fs/promises');
    await mkdir(host.dataDir, { recursive: true });
    await writeFile(
      join(host.dataDir, 'settings.json'),
      JSON.stringify({
        version: 1,
        defaultRoot: null,
        cacheDir: null,
        cacheCapGb: 20,
        autoResumeRenders: true,
        hwEncode: true,
        projectRoots: { p1: join(projectFolder, 'videos') },
      }),
    );
    await expect(newVideo(service, 'p1')).rejects.toThrow(/inside the project/);
  });

  it('puts a video in a folder the user picked for it, after checking that folder', async () => {
    const { service, base, projectFolder, host } = await setup();
    const picked = join(base, 'Elsewhere', 'Teasers');
    const create = (root: string) =>
      service.create({
        title: 'Shop teaser',
        projectId: 'p1',
        language: 'fa',
        aspect: '16:9',
        root,
      });
    const video = await create(picked);
    expect(video.folder.startsWith(picked)).toBe(true);
    expect(video.linkedProjectId).toBe('p1');
    // The pick is for this video only; the project keeps its own folder.
    expect((await service.projectStorage({ projectId: 'p1' })).root).toBe(
      join(host.defaultLibraryRoot, 'Projects', 'Shop-App'),
    );
    await expect(create(join(projectFolder, 'videos'))).rejects.toThrow(/inside the project/);
  });

  it('tells the UI the library changed', async () => {
    const { service, events } = await setup();
    await newVideo(service);
    expect(events).toContainEqual({ type: 'library-changed' });
  });
});

describe('editing a video', () => {
  it('opens, edits, undoes and keeps history', async () => {
    const { service } = await setup();
    const video = await newVideo(service);
    const session = await openSession(service, video.id);
    expect(session.status).toMatchObject({ seq: 1, canUndo: false });

    const applied = await service.apply({
      videoId: video.id,
      baseSeq: 1,
      ops: [{ op: 'scene.add', scene: createScene({ id: 's1', title: 'Hook' }), index: 0 }],
      label: 'Added a scene',
    });
    expect(applied).toMatchObject({
      ok: true,
      seq: 2,
      status: { canUndo: true, undoLabel: 'Added a scene' },
    });

    const undone = await service.undo({ videoId: video.id });
    expect(undone?.document.scenario.scenes).toEqual([]);
    const redone = await service.redo({ videoId: video.id });
    expect(redone?.document.scenario.scenes).toHaveLength(1);

    const history = await service.history({ videoId: video.id, limit: 10 });
    expect(history.map((h) => h.label)).toEqual([
      'Redo: Added a scene',
      'Undo: Added a scene',
      'Added a scene',
      'Video created',
    ]);
    expect((await service.version({ videoId: video.id, seq: 1 })).scenario.scenes).toEqual([]);
    const restored = await service.restore({ videoId: video.id, seq: 1 });
    expect(restored.document.scenario.scenes).toEqual([]);
  });

  it('answers a stale edit with where the video stands now instead of failing', async () => {
    const { service } = await setup();
    const video = await newVideo(service);
    await openSession(service, video.id);
    const op = { op: 'doc.set' as const, field: 'title' as const, value: 'x' };
    await service.apply({ videoId: video.id, baseSeq: 1, ops: [op], label: 'one' });
    const stale = await service.apply({ videoId: video.id, baseSeq: 1, ops: [op], label: 'two' });
    expect(stale).toMatchObject({ ok: false, reason: 'stale', seq: 2 });
  });

  it('opens an already-open video again without a second writer', async () => {
    const { service } = await setup();
    const video = await newVideo(service);
    await openSession(service, video.id);
    expect((await service.open({ videoId: video.id })).state).toBe('open');
  });

  it('refuses edits to a video that is not open', async () => {
    const { service } = await setup();
    const video = await newVideo(service);
    await expect(service.undo({ videoId: video.id })).rejects.toThrow(/not open/);
  });

  it('reports the edits it saved', async () => {
    const { service, events } = await setup();
    const video = await newVideo(service);
    await openSession(service, video.id);
    await service.apply({
      videoId: video.id,
      baseSeq: 1,
      ops: [{ op: 'doc.set', field: 'title', value: 'New' }],
      label: 'Renamed',
    });
    expect(events).toContainEqual({ type: 'video-changed', videoId: video.id, seq: 2 });
  });
});

describe('two copies of Runova', () => {
  it('lets only one open a video, and says which one has it', async () => {
    const first = await setup({ appId: 'Runova' });
    const video = await newVideo(first.service);
    await openSession(first.service, video.id);

    const second = await setup({ appId: 'Runova Dev', pid: 999_999_1 }, await tempDir());
    const added = await second.service.addExisting({ folder: video.folder });
    const result = await second.service.open({ videoId: added.id });
    expect(result).toMatchObject({
      state: 'locked',
      stale: false,
      holder: { appId: 'Runova', host: 'laptop' },
    });
    await expect(second.service.takeOver({ videoId: added.id })).resolves.toMatchObject({
      state: 'locked',
    });

    await first.service.close({ videoId: video.id });
    expect((await second.service.open({ videoId: added.id })).state).toBe('open');
  });

  it('takes over a video whose holder stopped answering', async () => {
    const first = await setup({ appId: 'Runova', hostname: 'desktop' });
    const video = await newVideo(first.service);
    await openSession(first.service, video.id);
    first.service.abandonForTest(video.id);

    const later = clock + 120_000;
    const second = await setup({ appId: 'Runova Dev', now: () => later }, await tempDir());
    const added = await second.service.addExisting({ folder: video.folder });
    expect(await second.service.open({ videoId: added.id })).toMatchObject({
      state: 'locked',
      stale: true,
    });
    expect((await second.service.takeOver({ videoId: added.id })).state).toBe('open');
  });
});

describe('library upkeep', () => {
  it('adds an existing video folder, and finds a moved one again', async () => {
    const { service, base } = await setup();
    const video = await newVideo(service);
    await service.removeFromLibrary({ videoId: video.id });
    expect(await service.list()).toEqual([]);
    await access(video.folder);

    const added = await service.addExisting({ folder: video.folder });
    expect(added.id).toBe(video.id);

    const moved = join(base, 'moved-here');
    const { rename } = await import('node:fs/promises');
    await rename(video.folder, moved);
    expect((await service.list())[0]?.missing).toBe(true);
    const located = await service.locate({ videoId: video.id, folder: moved });
    expect(located).toMatchObject({ folder: moved, missing: false });
  });

  it('refuses to locate a different video', async () => {
    const { service } = await setup();
    const a = await newVideo(service, null, 'A');
    const b = await newVideo(service, null, 'B');
    await expect(service.locate({ videoId: a.id, folder: b.folder })).rejects.toThrow(
      /different video/,
    );
  });

  it('moves a video to another folder and keeps the old copy for the user to delete', async () => {
    const { service, base } = await setup();
    const video = await newVideo(service);
    const session = await openSession(service, video.id);
    await service.apply({
      videoId: video.id,
      baseSeq: session.status.seq,
      ops: [{ op: 'doc.set', field: 'title', value: 'Moved film' }],
      label: 'Renamed',
    });
    const target = join(base, 'Archive');
    const result = await service.move({ videoId: video.id, toRoot: target });
    expect(result.oldFolder).toBe(video.folder);
    expect(result.video.folder.startsWith(target)).toBe(true);
    expect(await readdir(result.video.folder)).not.toContain('.studio.lock');
    const reopened = await openSession(service, video.id);
    expect(reopened.document.title).toBe('Moved film');
    expect(reopened.status.seq).toBe(2);
  });

  it('refuses to move a video into a project source folder', async () => {
    const { service, projectFolder } = await setup();
    const video = await newVideo(service, 'p1');
    await expect(
      service.move({ videoId: video.id, toRoot: join(projectFolder, 'v') }),
    ).rejects.toThrow(/inside the project/);
  });

  it('closes every open video on shutdown, so their locks are released', async () => {
    const { service } = await setup();
    const video = await newVideo(service);
    await openSession(service, video.id);
    await service.shutdown();
    expect(await readdir(video.folder)).not.toContain('.studio.lock');
  });
});

describe('scene files', () => {
  it('serves a file of a tree in the shared library, and nothing for an unknown tree or path', async () => {
    const { service } = await setup();
    const tree = await treeFromFiles(
      [
        { path: 'index.html', content: '<p>سلام</p>' },
        { path: 'scene.js', content: 'Studio.scene({ render() {} })' },
      ],
      service.libraryBlobs,
    );
    const file = await service.sceneFile({ treeHash: tree.treeHash, path: 'index.html' });
    expect(Buffer.from(file ?? []).toString()).toBe('<p>سلام</p>');
    // Read twice: the second comes from the cached manifest.
    expect(await service.sceneFile({ treeHash: tree.treeHash, path: 'scene.js' })).not.toBeNull();
    expect(await service.sceneFile({ treeHash: tree.treeHash, path: 'missing.js' })).toBeNull();
    expect(await service.sceneFile({ treeHash: 'f'.repeat(64), path: 'index.html' })).toBeNull();
  });
});

describe('style reference scenes', () => {
  it('stores a reference scene once and gives its preview address in the language asked', async () => {
    const { service } = await setup();
    const fa = await service.styleReference({ styleId: 'bauhaus', aspect: '9:16', language: 'fa' });
    expect(fa.url).toMatch(/^studio-scene:\/\/t-[0-9a-f]{64}\/index\.html\?c=/);
    const again = await service.styleReference({
      styleId: 'bauhaus',
      aspect: '16:9',
      language: 'en',
    });
    expect(again.treeHash).toBe(fa.treeHash);
    expect(again.url).not.toBe(fa.url);
    const html = await service.sceneFile({ treeHash: fa.treeHash, path: 'index.html' });
    expect(Buffer.from(html ?? []).toString()).toContain('Studio.scene(');
  });

  it('checks a reference scene through the host', async () => {
    const check = vi.fn(async () => ({
      ok: true,
      problems: [],
      notes: [],
      thumbnail: null,
      thumbnailPng: null,
    }));
    const { service } = await setup({ scenes: { check } });
    expect(
      await service.checkStyleReference({ styleId: 'hud', aspect: '16:9', language: 'en' }),
    ).toEqual({
      ok: true,
      problems: [],
      notes: [],
    });
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1920, height: 1080, duration: 6, fps: 30 }),
    );
    const { service: bare } = await setup();
    await expect(
      bare.checkStyleReference({ styleId: 'hud', aspect: '16:9', language: 'en' }),
    ).rejects.toThrow(/cannot check scenes/);
  });
});

describe('scene network per project', () => {
  it('keeps the hosts a project allows, shows them with its folder, and forgets them with the project', async () => {
    const { service } = await setup();
    expect((await service.projectStorage({ projectId: 'p1' })).sceneHosts).toEqual([]);
    const view = await service.setSceneHosts({
      projectId: 'p1',
      hosts: ['cdn.example.com', 'cdn.example.com', 'fonts.example.org'],
    });
    expect(view.sceneHosts).toEqual(['cdn.example.com', 'fonts.example.org']);
    expect((await service.setSceneHosts({ projectId: 'p1', hosts: [] })).sceneHosts).toEqual([]);
    await service.setSceneHosts({ projectId: 'p1', hosts: ['cdn.example.com'] });
    // A project that is gone from Runova loses its list along with its folder setting.
    await service.pruneProjects(new Set());
    expect((await service.projectStorage({ projectId: 'p1' })).sceneHosts).toEqual([]);
    await expect(service.setSceneHosts({ projectId: 'ghost', hosts: [] })).rejects.toThrow(
      /not in Runova/,
    );
  });

  it("gives a scene the hosts of its video's project, and none to a standalone video", async () => {
    const { service } = await setup();
    await service.setSceneHosts({ projectId: 'p1', hosts: ['cdn.example.com'] });
    const project = await newVideo(service, 'p1');
    const standalone = await newVideo(service, null, 'Alone');
    await openSession(service, project.id);
    await openSession(service, standalone.id);
    // A tree only one open video holds: written straight into that video's blob folder.
    const projectTree = await treeFromFiles(
      [{ path: 'index.html', content: 'p' }],
      BlobStore.forVideo(project.folder),
    );
    const aloneTree = await treeFromFiles(
      [{ path: 'index.html', content: 'a' }],
      BlobStore.forVideo(standalone.folder),
    );
    expect(await service.sceneHosts({ treeHash: projectTree.treeHash })).toEqual([
      'cdn.example.com',
    ]);
    expect(await service.sceneHosts({ treeHash: aloneTree.treeHash })).toEqual([]);
    expect(await service.sceneHosts({ treeHash: 'f'.repeat(64) })).toEqual([]);
  });

  it('reads a settings file from before scene networks without losing anything in it', async () => {
    const root = await tempDir();
    const dataDir = join(root, 'userData', 'studio');
    await mkdir(dataDir, { recursive: true });
    const custom = join(root, 'media');
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({
        version: 1,
        defaultRoot: null,
        cacheDir: null,
        cacheCapGb: 33,
        autoResumeRenders: true,
        hwEncode: true,
        projectRoots: { p1: custom },
      }),
    );
    const { service } = await setup({}, root);
    expect((await service.settings()).cacheCapGb).toBe(33);
    expect(await service.projectStorage({ projectId: 'p1' })).toMatchObject({
      root: custom,
      isCustom: true,
      sceneHosts: [],
    });
  });
});

describe('rendering', () => {
  async function renderableVideo(s: Setup) {
    await s.service.setSceneHosts({ projectId: 'p1', hosts: ['cdn.example.com'] });
    const video = await newVideo(s.service, 'p1');
    const session = await openSession(s.service, video.id);
    const added = await s.service.apply({
      videoId: video.id,
      baseSeq: session.status.seq,
      ops: [
        {
          op: 'scene.add',
          scene: createScene({ id: 's1', targetDuration: 705_600_000 }),
          index: 0,
        },
        { op: 'render.set', patch: { fps: 24, resolution: '720p', hwEncode: false } },
      ],
      label: 'Scene',
    });
    if (!added.ok) throw new Error('not applied');
    const saved = await s.service.saveSceneFiles({
      videoId: video.id,
      sceneId: 's1',
      files: [{ path: 'index.html', content: '<p>scene</p>' }],
    });
    const treeHash = saved.document.scenario.scenes[0]?.code.treeHash as string;
    return { video, treeHash };
  }

  async function finished(s: StudioService, jobId: string) {
    for (let i = 0; i < 400; i++) {
      const job = (await s.renderJobs({})).find((j) => j.id === jobId);
      if (job && !['queued', 'running'].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the render did not finish');
  }

  it('renders an open video, serving its code even after the editor closes it', async () => {
    const { fakeFrameHost } = await import('../test/fakeFrames.js');
    const { fakeTools } = await import('../test/ffmpegTools.js');
    const served: (string | null)[] = [];
    const hosts: (readonly string[])[] = [];
    let service: StudioService | null = null;
    const frames = fakeFrameHost({ fixedSize: { width: 16, height: 9 } });
    const s = await setup({
      render: {
        tools: async () => fakeTools,
        frames: {
          open(input) {
            hosts.push(input.allowedHosts);
            const source = frames.open(input);
            return {
              ...source,
              async open(url) {
                const tree = /t-([0-9a-f]{64})/.exec(url)?.[1] as string;
                const file = await (service as StudioService).sceneFile({
                  treeHash: tree,
                  path: 'index.html',
                });
                served.push(file ? Buffer.from(file).toString('utf8') : null);
                await source.open(url);
              },
            };
          },
        },
      },
    });
    service = s.service;
    const { video, treeHash } = await renderableVideo(s);
    expect((await s.service.renderTools()).codecs.h264).toBeNull();
    const estimate = await s.service.renderEstimate({ videoId: video.id });
    expect(estimate).toMatchObject({ ok: true, frames: 24, width: 1280, height: 720 });

    const job = await s.service.startRender({ videoId: video.id, fileName: 'Teaser' });
    await expect(
      s.service.move({ videoId: video.id, toRoot: join(s.base, 'Archive') }),
    ).rejects.toThrow(
      'This video is rendering. Wait for the render to finish, or cancel it, then move it.',
    );
    await s.service.close({ videoId: video.id });
    const done = await finished(s.service, job.id);
    expect(done).toMatchObject({ status: 'done', fileName: 'Teaser.mp4' });
    expect(done.output).toBe(join(video.folder, 'renders', 'Teaser.mp4'));
    expect(served).toEqual(['<p>scene</p>']);
    expect(hosts).toEqual([['cdn.example.com']]);
    // Once the render is over, a closed video's code is no longer served.
    expect(await s.service.sceneFile({ treeHash, path: 'index.html' })).toBeNull();

    await s.service.removeRender({ jobId: job.id });
    expect(await s.service.renderJobs({ videoId: video.id })).toEqual([]);
  });

  it('encodes on the graphics card only when Settings allows it as well as the video', async () => {
    const { fakeFrameHost } = await import('../test/fakeFrames.js');
    const { fakeTools } = await import('../test/ffmpegTools.js');
    const s = await setup({
      render: {
        tools: async () => fakeTools,
        frames: fakeFrameHost({ fixedSize: { width: 16, height: 9 } }),
      },
    });
    const { video } = await renderableVideo(s);
    const session = await openSession(s.service, video.id);
    await s.service.apply({
      videoId: video.id,
      baseSeq: session.status.seq,
      ops: [{ op: 'render.set', patch: { hwEncode: true } }],
      label: 'GPU',
    });
    const onGpu = await s.service.startRender({ videoId: video.id });
    expect((await finished(s.service, onGpu.id)).hardware).toBe('h264_nvenc');
    await s.service.updateSettings({ hwEncode: false });
    const offGpu = await s.service.startRender({ videoId: video.id });
    expect(offGpu.settings.hwEncode).toBe(false);
    expect((await finished(s.service, offGpu.id)).hardware).toBeNull();
    // The video keeps its own choice for when Settings allows it again.
    expect((await openSession(s.service, video.id)).document.renderSettings.hwEncode).toBe(true);
  });

  it('cancels and retries through the service, and resumes on request', async () => {
    const { fakeFrameHost } = await import('../test/fakeFrames.js');
    const { fakeTools } = await import('../test/ffmpegTools.js');
    const s = await setup({
      render: {
        tools: async () => fakeTools,
        frames: fakeFrameHost({ fixedSize: { width: 16, height: 9 } }),
      },
    });
    const { video } = await renderableVideo(s);
    const job = await s.service.startRender({ videoId: video.id });
    await s.service.cancelRender({ jobId: job.id });
    expect((await finished(s.service, job.id)).status).toBe('cancelled');
    await s.service.retryRender({ jobId: job.id });
    expect((await finished(s.service, job.id)).status).toBe('done');
    await s.service.resumeRenders();
    expect((await s.service.renderJobs({}))[0]?.status).toBe('done');
  });

  it('says rendering is unavailable on a host without it', async () => {
    const s = await setup();
    const { video } = await renderableVideo(s);
    await expect(s.service.startRender({ videoId: video.id })).rejects.toThrow(
      'Rendering is not available here.',
    );
    expect((await s.service.renderTools()).ffmpeg.found).toBe(false);
  });

  it('leaves the cache of a video alone while it is rendering', async () => {
    const { fakeFrameHost } = await import('../test/fakeFrames.js');
    const { fakeTools } = await import('../test/ffmpegTools.js');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const frames = fakeFrameHost({ fixedSize: { width: 16, height: 9 } });
    const s = await setup({
      render: {
        tools: async () => fakeTools,
        frames: {
          open(input) {
            const source = frames.open(input);
            return {
              ...source,
              async open(url) {
                await gate;
                await source.open(url);
              },
            };
          },
        },
      },
    });
    const { video } = await renderableVideo(s);
    await mkdir(join(s.host.defaultCacheDir, video.id, 'scenes', 'abc'), { recursive: true });
    await writeFile(
      join(s.host.defaultCacheDir, video.id, 'scenes', 'abc', 'chunk.mkv'),
      'x'.repeat(64),
    );

    const job = await s.service.startRender({ videoId: video.id });
    const usage = await s.service.cacheUsage({ projectId: 'p1' });
    expect(usage.videos).toEqual([
      { videoId: video.id, title: 'Launch film', bytes: 64, busy: true },
    ]);
    const result = await s.service.clearCache({ videoIds: [video.id] });
    expect(result).toEqual({
      freedBytes: 0,
      cleared: [],
      skipped: [{ videoId: video.id, reason: 'busy' }],
    });
    expect(await readdir(join(s.host.defaultCacheDir, video.id, 'scenes', 'abc'))).toContain(
      'chunk.mkv',
    );

    release();
    await finished(s.service, job.id);
  });
});

describe('narration', () => {
  async function narratable() {
    const { fakeFrameHost } = await import('../test/fakeFrames.js');
    const { fakeTools } = await import('../test/ffmpegTools.js');
    const { GOOD_KEY, startFakeTts } = await import('../test/fakeTts.js');
    const tts = await startFakeTts();
    const secrets = new Map<string, string>();
    const s = await setup({
      render: { tools: async () => fakeTools, frames: fakeFrameHost() },
      voice: {
        appKeys: async () => ({ openai: GOOD_KEY }),
        secrets: {
          get: async (name) => secrets.get(name) ?? null,
          set: async (name, value) => {
            if (value === null) secrets.delete(name);
            else secrets.set(name, value);
          },
          isLocked: async () => false,
        },
        fetch,
        baseUrl: tts.url,
      },
    });
    const video = await newVideo(s.service);
    const session = await openSession(s.service, video.id);
    await s.service.apply({
      videoId: video.id,
      baseSeq: session.status.seq,
      ops: [
        { op: 'scene.add', index: 0, scene: createScene({ id: 'a', narration: 'سلام دنیا.' }) },
        { op: 'scene.add', index: 1, scene: createScene({ id: 'b', narration: 'خداحافظ.' }) },
      ],
      label: 'Scenes',
    });
    return { s, video, tts, GOOD_KEY };
  }

  async function waitForJob(service: StudioService, videoId: string) {
    for (let i = 0; i < 400; i++) {
      const [job] = await service.narrationJobs({ videoId });
      if (job && job.status !== 'running') return job;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('narration did not finish');
  }

  it('speaks scenes with an engine whose key the app has, and keeps Studio keys sealed', async () => {
    const { s, video, tts, GOOD_KEY } = await narratable();
    try {
      const engines = await s.service.voiceEngines();
      expect(engines.find((e) => e.id === 'openai')?.problem).toBeNull();
      expect((await s.service.voices({ engine: 'openai', lang: 'fa' })).length).toBe(13);
      const after = await s.service.setVoiceKey({ engine: 'elevenlabs', key: GOOD_KEY });
      expect(after.find((e) => e.id === 'elevenlabs')?.problem).toBeNull();

      const job = await s.service.speak({
        videoId: video.id,
        sceneIds: ['a', 'b'],
        voiceRef: 'openai:marin',
      });
      expect(job.status).toBe('running');
      expect((await waitForJob(s.service, video.id)).status).toBe('done');
      const doc = (await openSession(s.service, video.id)).document;
      expect(doc.scenario.scenes.map((sc) => sc.voiceRef)).toEqual([
        'openai:marin',
        'openai:marin',
      ]);
      expect(doc.timeline.clips.filter((c) => c.trackId === 'track-voice')).toHaveLength(2);
      expect(s.events.some((e) => e.type === 'narration-changed')).toBe(true);

      const captioned = await s.service.captionScene({ videoId: video.id, sceneId: 'a' });
      expect(captioned.document.timeline.clips.some((c) => c.trackId === 'track-text')).toBe(true);
    } finally {
      await tts.close();
    }
  });

  it('places a recording, cleans up its temporary file, and stops speaking when Studio shuts down', async () => {
    const { s, video, tts } = await narratable();
    try {
      const { encodeWav } = await import('../voice/wav.js');
      const { tonePcm } = await import('../test/fakeTts.js');
      const placed = await s.service.recordNarration({
        videoId: video.id,
        sceneId: 'b',
        bytes: encodeWav(tonePcm(1, 48_000), 48_000),
        mimeType: 'audio/wav',
      });
      expect(placed.document.scenario.scenes[1]?.voiceRef).toBe('recording');
      const recordings = join(s.host.defaultCacheDir, video.id, 'voice', 'recordings');
      expect(await readdir(recordings)).toEqual([]);

      tts.failNext(1000, 503);
      await s.service.speak({ videoId: video.id, sceneIds: ['a'], voiceRef: 'openai:marin' });
      await s.service.shutdown();
      expect((await s.service.narrationJobs({ videoId: video.id }))[0]?.status).toBe('cancelled');
      await expect(
        s.service.speak({ videoId: video.id, sceneIds: ['a'], voiceRef: 'openai:marin' }),
      ).rejects.toThrow('That video is not open.');
    } finally {
      tts.failNext(0, 503);
      await tts.close();
    }
  });

  it('keeps speaking after the editor closes the video, then closes it', async () => {
    const { s, video, tts } = await narratable();
    const release = tts.hold();
    try {
      await s.service.speak({ videoId: video.id, sceneIds: ['a', 'b'], voiceRef: 'openai:marin' });
      await s.service.close({ videoId: video.id });
      // Still open: the scenes are still being spoken and can be watched.
      expect((await s.service.narrationJobs({ videoId: video.id }))[0]?.status).toBe('running');
      expect((await s.service.history({ videoId: video.id, limit: 1 })).length).toBe(1);
      release();
      expect((await waitForJob(s.service, video.id)).status).toBe('done');
      await vi.waitFor(async () => {
        await expect(s.service.history({ videoId: video.id, limit: 1 })).rejects.toThrow(
          /not open/,
        );
      });
      // What was spoken is in the video when it opens again.
      const again = await openSession(s.service, video.id);
      expect(again.document.scenario.scenes.map((scene) => scene.voiceRef)).toEqual([
        'openai:marin',
        'openai:marin',
      ]);
    } finally {
      release();
      await tts.close();
    }
  });

  it('cancels the pending close when the video opens again while it speaks', async () => {
    const { s, video, tts } = await narratable();
    const release = tts.hold();
    try {
      await s.service.speak({ videoId: video.id, sceneIds: ['a'], voiceRef: 'openai:marin' });
      await s.service.close({ videoId: video.id });
      const again = await openSession(s.service, video.id);
      release();
      expect((await waitForJob(s.service, video.id)).status).toBe('done');
      // The video stayed open for the editor that came back, so edits still go through.
      const status = (await openSession(s.service, video.id)).status;
      await expect(
        s.service.apply({
          videoId: video.id,
          baseSeq: status.seq,
          ops: [{ op: 'doc.set', field: 'title', value: 'Back again' }],
          label: 'Renamed',
        }),
      ).resolves.toMatchObject({ document: { title: 'Back again' } });
      expect(again.document.id).toBe(video.id);
    } finally {
      release();
      await tts.close();
    }
  });

  it('never hands over a video that is still closing', async () => {
    const { s, video, tts } = await narratable();
    const release = tts.hold();
    try {
      await s.service.speak({ videoId: video.id, sceneIds: ['a'], voiceRef: 'openai:marin' });
      // Removing it stops the run first; an open that comes in meanwhile waits for the close
      // instead of getting the session that is about to go away.
      const removing = s.service.removeFromLibrary({ videoId: video.id });
      const reopened = s.service.open({ videoId: video.id });
      await removing;
      await expect(reopened).rejects.toThrow('That video is not in the Studio library.');
    } finally {
      release();
      await tts.close();
    }
  });

  it('says voices are unavailable on a host without them', async () => {
    const s = await setup();
    expect((await s.service.voiceEngines())[0]?.problem).toBe(
      'Voices are not available in this copy of Studio.',
    );
  });
});

describe('the render cache of a project', () => {
  /** Writes files of the given sizes into a video's cache folder. */
  async function seed(
    cacheRoot: string,
    videoId: string,
    files: Record<string, number>,
  ): Promise<void> {
    for (const [path, size] of Object.entries(files)) {
      const file = join(cacheRoot, videoId, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, Buffer.alloc(size));
    }
  }

  it('lists the videos of the project with what their cache could free, biggest first', async () => {
    const { service, host } = await setup();
    const launch = await newVideo(service, 'p1', 'Launch film');
    const teaser = await newVideo(service, 'p1', 'Teaser');
    const other = await newVideo(service, null, 'Not in the project');
    await seed(host.defaultCacheDir, launch.id, {
      'scenes/abc/chunk.mkv': 1000,
      'media/h1/proxy.mp4': 200,
      'voice/recordings/take.wav': 5000,
    });
    await seed(host.defaultCacheDir, teaser.id, { 'scenes/def/chunk.mkv': 50 });
    await seed(host.defaultCacheDir, other.id, { 'scenes/zzz/chunk.mkv': 9999 });

    expect(await service.cacheUsage({ projectId: 'p1' })).toEqual({
      videos: [
        { videoId: launch.id, title: 'Launch film', bytes: 1200, busy: false },
        { videoId: teaser.id, title: 'Teaser', bytes: 50, busy: false },
      ],
    });
  });

  it('leaves out a video with nothing that can be cleared', async () => {
    const { service, host } = await setup();
    const video = await newVideo(service, 'p1');
    await seed(host.defaultCacheDir, video.id, { 'voice/recordings/take.wav': 5000 });
    expect((await service.cacheUsage({ projectId: 'p1' })).videos).toEqual([]);
  });

  it('answers with nothing for a project it has no videos for', async () => {
    const { service } = await setup();
    expect(await service.cacheUsage({ projectId: 'ghost' })).toEqual({ videos: [] });
  });

  it('clears the scene and media caches and keeps the recordings and generated media', async () => {
    const { service, host } = await setup();
    const video = await newVideo(service, 'p1');
    await seed(host.defaultCacheDir, video.id, {
      'scenes/abc/chunk.mkv': 1000,
      'media/h1/proxy.mp4': 200,
      'voice/recordings/take.wav': 5000,
      'gen/j1/image.png': 7000,
    });

    const result = await service.clearCache({ videoIds: [video.id] });
    expect(result).toEqual({ freedBytes: 1200, cleared: [video.id], skipped: [] });
    expect((await readdir(join(host.defaultCacheDir, video.id))).sort()).toEqual(['gen', 'voice']);
    expect((await service.cacheUsage({ projectId: 'p1' })).videos).toEqual([]);
  });

  it('skips ids it does not know and never builds a path out of them', async () => {
    const { service, host, base } = await setup();
    const victim = join(base, 'userData', 'victim');
    await mkdir(join(victim, 'scenes', 'x'), { recursive: true });
    await writeFile(join(victim, 'scenes', 'x', 'keep.txt'), 'keep');
    expect(host.defaultCacheDir).toBe(join(base, 'userData', 'studio-cache'));

    const result = await service.clearCache({ videoIds: ['../victim', '..', 'nope', '__proto__'] });
    expect(result.cleared).toEqual([]);
    expect(result.freedBytes).toBe(0);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
    expect(await readdir(join(victim, 'scenes', 'x'))).toEqual(['keep.txt']);
  });

  it('counts a video once when its id is asked for twice', async () => {
    const { service, host } = await setup();
    const video = await newVideo(service, 'p1');
    await seed(host.defaultCacheDir, video.id, { 'scenes/abc/chunk.mkv': 100 });
    const result = await service.clearCache({ videoIds: [video.id, video.id] });
    expect(result).toEqual({ freedBytes: 100, cleared: [video.id], skipped: [] });
  });

  it('reads the cache folder from where the user moved it', async () => {
    const { service, base } = await setup();
    const moved = join(base, 'fast-disk', 'cache');
    await service.updateSettings({ cacheDir: moved });
    const video = await newVideo(service, 'p1');
    await seed(moved, video.id, { 'scenes/abc/chunk.mkv': 300 });
    expect((await service.cacheUsage({ projectId: 'p1' })).videos[0]?.bytes).toBe(300);
    expect((await service.clearCache({ videoIds: [video.id] })).freedBytes).toBe(300);
  });
});
