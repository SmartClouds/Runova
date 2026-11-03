import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiTool, ToolContext } from '../registry';

const FLICKS_PER_SECOND = 705_600_000;

const studio = vi.hoisted(() => ({
  /** Videos the user already has open in the editor. */
  openInEditor: new Set<string>(),
  locked: false,
  stale: false,
  seq: 4,
  list: vi.fn(async (_input?: { projectId?: string | null }) => [
    {
      id: 'v1',
      title: 'Launch video',
      folder: 'C:/studio/launch',
      linkedProjectId: 'p1',
      createdAt: 1,
      lastOpenedAt: 100,
      missing: false,
    },
    {
      id: 'v2',
      title: 'Tutorial',
      folder: 'C:/studio/tutorial',
      linkedProjectId: null,
      createdAt: 2,
      lastOpenedAt: null,
      missing: false,
    },
  ]),
  close: vi.fn(async (_input: { videoId: string }) => undefined),
  apply: vi.fn(async (_input: unknown) => ({ ok: true })),
}));

function documentOf(title: string) {
  return {
    schemaVersion: 1,
    id: 'doc',
    title,
    language: 'en',
    styleId: null,
    customStyle: null,
    scenario: {
      logline: 'A new app launches',
      audience: 'Developers',
      tone: 'Upbeat',
      scenes: [
        {
          id: 's1',
          title: 'Intro',
          narration: 'Meet Runova.',
          onScreenText: ['Runova'],
          targetDuration: 5 * FLICKS_PER_SECOND,
          timing: 'fixed',
          visualKind: 'motion',
          visualBrief: 'The logo builds up',
          transitionOut: null,
          musicCue: '',
          voiceRef: null,
          notes: '',
          code: { treeHash: null },
          params: {},
        },
        {
          id: 's2',
          title: 'Features',
          narration: 'It does a lot.',
          onScreenText: [],
          targetDuration: 8 * FLICKS_PER_SECOND,
          timing: 'narration',
          visualKind: 'media',
          visualBrief: '',
          transitionOut: null,
          musicCue: '',
          voiceRef: null,
          notes: '',
          code: { treeHash: null },
          params: {},
        },
      ],
    },
    timeline: { tracks: [{ id: 't1' }], clips: [{ id: 'c1' }, { id: 'c2' }] },
    renderSettings: {},
  };
}

vi.mock('../../studio', () => ({
  studioService: () => ({
    list: studio.list,
    close: studio.close,
    async open({ videoId }: { videoId: string }) {
      if (studio.locked) {
        return {
          state: 'locked',
          holder: { appId: 'runova', host: 'OTHER-PC', pid: 1, heartbeatAt: 0 },
          stale: false,
        };
      }
      const video = (await studio.list()).find((one) => one.id === videoId);
      const already = studio.openInEditor.has(videoId);
      return {
        state: 'open',
        session: {
          video: { ...video, lastOpenedAt: already ? video?.lastOpenedAt : 999_999 },
          document: documentOf(video?.title ?? ''),
          status: {
            seq: studio.seq,
            canUndo: true,
            canRedo: false,
            undoLabel: null,
            redoLabel: null,
          },
        },
      };
    },
    async apply(input: unknown) {
      await studio.apply(input);
      return studio.stale ? { ok: false, reason: 'stale' } : { ok: true, seq: studio.seq + 1 };
    },
  }),
}));

/** Studio tools: the videos, one video's scenario and scenes, and plain text edits to them. */

const context: ToolContext = { projectId: 'p1', callerKind: 'runova', agent: 'Claude', cwd: null };
let tools: Map<string, AiTool>;

beforeEach(async () => {
  studio.openInEditor = new Set();
  studio.locked = false;
  studio.stale = false;
  studio.list.mockClear();
  studio.close.mockClear();
  studio.apply.mockClear();
  const { studioTools } = await import('./studio');
  tools = new Map(studioTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

describe('studio tools', () => {
  it("lists the videos, or only the project's", async () => {
    expect((await run('studio_list_videos')).data).toEqual([
      expect.objectContaining({ id: 'v1', title: 'Launch video', projectId: 'p1' }),
      expect.objectContaining({ id: 'v2', title: 'Tutorial', projectId: null }),
    ]);
    await run('studio_list_videos', { forProject: true });
    expect(studio.list).toHaveBeenLastCalledWith({ projectId: 'p1' });
  });

  it('reads a video by title with its scenes, closing it again only if it opened it', async () => {
    const data = (await run('studio_video_details', { video: 'launch VIDEO' })).data;
    expect(data).toMatchObject({
      id: 'v1',
      title: 'Launch video',
      scenario: { logline: 'A new app launches' },
      scenes: [
        { number: 1, id: 's1', title: 'Intro', narration: 'Meet Runova.', seconds: 5 },
        { number: 2, id: 's2', title: 'Features', seconds: 8 },
      ],
      timeline: { tracks: 1, clips: 2 },
      version: 4,
    });
    expect(studio.close).toHaveBeenCalledWith({ videoId: 'v1' });

    studio.openInEditor.add('v1');
    studio.close.mockClear();
    await run('studio_video_details', { video: 'v1' });
    expect(studio.close).not.toHaveBeenCalled();
  });

  it('edits a scene found by number through one undoable apply', async () => {
    const tool = tools.get('studio_update_scene') as AiTool;
    expect(tool.risk).toBe('write');
    const result = await run('studio_update_scene', {
      video: 'Launch video',
      scene: '2',
      narration: 'It does even more.',
    });
    expect(studio.apply).toHaveBeenCalledWith({
      videoId: 'v1',
      baseSeq: 4,
      ops: [{ op: 'scene.update', sceneId: 's2', patch: { narration: 'It does even more.' } }],
      label: expect.stringContaining('Features'),
    });
    expect(result.text).toContain('Features');
    await expect(run('studio_update_scene', { video: 'v1', scene: 'Intro' })).rejects.toThrow(
      'Nothing to change',
    );
    await expect(
      run('studio_update_scene', { video: 'v1', scene: 'Outro', title: 'x' }),
    ).rejects.toThrow('Intro, Features');
  });

  it("changes the video's title and scenario in one edit, and says when the video moved on", async () => {
    await run('studio_update_video', { video: 'v2', title: 'Tutorial v2', tone: 'Calm' });
    expect(studio.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        videoId: 'v2',
        ops: [
          { op: 'doc.set', field: 'title', value: 'Tutorial v2' },
          { op: 'scenario.set', patch: { tone: 'Calm' } },
        ],
      }),
    );
    studio.stale = true;
    await expect(run('studio_update_video', { video: 'v2', tone: 'Bold' })).rejects.toThrow(
      'changed while',
    );
  });

  it('says when another copy of Runova holds the video', async () => {
    studio.locked = true;
    await expect(run('studio_video_details', { video: 'v1' })).rejects.toThrow('OTHER-PC');
  });
});
