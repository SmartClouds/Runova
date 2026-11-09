import type { StudioEvent } from '@runova/studio';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_MS, type ManageStudioDeps, studioDownloads, studioMethods } from './studioMethods';

const VIDEO = 'video-1';

function scene(id: string, treeHash: string | null = null) {
  return {
    id,
    title: `Scene ${id}`,
    narration: 'Words',
    targetDuration: 705_600_000 * 3,
    code: { treeHash },
  };
}

function session(scenes = [scene('a', 'f'.repeat(64)), scene('b')]) {
  return {
    state: 'open' as const,
    session: {
      video: { id: VIDEO, title: 'Launch film' },
      status: { seq: 4, canUndo: true, canRedo: false, undoLabel: 'Edit', redoLabel: null },
      document: {
        language: 'en',
        timeline: {
          tracks: [
            {
              id: 't1',
              kind: 'music',
              name: 'Music',
              muted: false,
              solo: false,
              locked: false,
              volume: 1,
            },
            {
              id: 't2',
              kind: 'voice',
              name: 'Voice',
              muted: false,
              solo: false,
              locked: true,
              volume: 1,
            },
          ],
          clips: [
            {
              id: 'c1',
              trackId: 't1',
              start: 0,
              duration: 705_600_000,
              gain: 1,
              fadeIn: 0,
              fadeOut: 0,
              source: { type: 'media', hash: 'a'.repeat(64), in: 0, out: 705_600_000 },
              transitionIn: null,
            },
            {
              id: 'c2',
              trackId: 't2',
              start: 0,
              duration: 705_600_000,
              gain: 1,
              fadeIn: 0,
              fadeOut: 0,
              source: { type: 'text', text: 'Hello' },
              transitionIn: null,
            },
          ],
        },
        renderSettings: { aspect: '16:9', quality: 'standard', resolution: '1080p', fps: 30 },
        scenario: { scenes },
      },
    },
  };
}

function setup() {
  const files = {
    stat: vi.fn(async () => ({ size: 10, mtimeMs: 5 }) as { size: number; mtimeMs: number } | null),
    read: vi.fn(async () => new Uint8Array([9, 9])),
  };
  let listener: (event: StudioEvent) => void = () => undefined;
  let now = 1_000_000;
  const service = {
    list: vi.fn(async () => [
      {
        id: VIDEO,
        title: 'Launch film',
        folder: 'C:/secret',
        pinned: true,
        missing: false,
        createdAt: 10,
        lastOpenedAt: 999_000,
      },
    ]),
    create: vi.fn(async () => ({ id: VIDEO })),
    hold: vi.fn(async () => session()),
    release: vi.fn(async () => undefined),
    apply: vi.fn(async () => ({ ok: true })),
    undo: vi.fn(async () => null),
    startScenario: vi.fn(async () => ({})),
    startEdit: vi.fn(async () => ({})),
    startScene: vi.fn(async () => ({})),
    generations: vi.fn(async () => [] as unknown[]),
    cancelGeneration: vi.fn(async () => undefined),
    applyProposal: vi.fn(async () => ({})),
    discardProposal: vi.fn(async () => undefined),
    renderEstimate: vi.fn(async () => ({
      ok: false as const,
      problems: ['Animate every scene first.'],
    })),
    startRender: vi.fn(async () => ({})),
    renderJobs: vi.fn(async () => [] as unknown[]),
    cancelRender: vi.fn(async () => undefined),
    thumbnail: vi.fn(async () => new Uint8Array([1, 2])),
    voiceEngines: vi.fn(async () => [
      {
        id: 'openai',
        label: 'OpenAI',
        problem: null,
        locked: false,
        local: false,
        nonCommercial: false,
        pricePerMillionChars: 15_000,
      },
      {
        id: 'gemini',
        label: 'Gemini',
        problem: null,
        locked: false,
        local: false,
        nonCommercial: false,
        pricePerMillionChars: null,
      },
      {
        id: 'piper',
        label: 'Piper',
        problem: null,
        locked: false,
        local: true,
        nonCommercial: false,
        pricePerMillionChars: null,
      },
    ]),
    voices: vi.fn(async () => [{ id: 'alloy', label: 'Alloy' }]),
    speak: vi.fn(async () => ({})),
    narrationJobs: vi.fn(async () => [] as unknown[]),
    cancelNarration: vi.fn(async () => undefined),
    captionScene: vi.fn(async () => ({})),
    media: vi.fn(async () => [
      {
        hash: 'a'.repeat(64),
        name: 'Song.mp3',
        kind: 'audio',
        duration: 705_600_000,
        preparing: false,
        problem: null,
      },
    ]),
  };
  const deps = {
    service: () => service,
    onEvent: (next: (event: StudioEvent) => void) => {
      listener = next;
      return () => undefined;
    },
    now: () => now,
    files,
  } as unknown as ManageStudioDeps;
  const calls = studioMethods(deps);
  const downloads = studioDownloads(deps);
  return {
    service,
    files,
    downloads,
    call: (name: string, params?: unknown) =>
      (calls[name] as (p: unknown) => Promise<never>)(params),
    emit: (event: StudioEvent) => listener(event),
    tick: (ms: number) => {
      now += ms;
    },
  };
}

function run(over: Record<string, unknown> = {}) {
  return {
    id: 'g1',
    stage: 'scene',
    status: 'running',
    cliName: 'Claude Code',
    instruction: 'Animate',
    attempts: [{}, {}],
    proposal: null,
    error: null,
    startedAt: 990_000,
    finishedAt: null,
    ...over,
  };
}

describe('studio on a phone', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('lists videos without saying where they are', async () => {
    const { call } = setup();
    const [video] = (await call('studio.list')) as Record<string, unknown>[];
    expect(video).toMatchObject({
      id: VIDEO,
      title: 'Launch film',
      pinned: true,
      openedAgoMs: 1000,
    });
    expect(JSON.stringify(video)).not.toContain('secret');
  });

  it('starts a new video from a prompt and keeps it open', async () => {
    const { call, service } = setup();
    const result = await call('studio.create', {
      brief: 'A launch film\nfor the shop',
      aspect: '9:16',
      language: 'en',
      seconds: 30,
      styleId: null,
    });
    expect(result).toEqual({ videoId: VIDEO });
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'A launch film', aspect: '9:16', language: 'en' }),
    );
    expect(service.hold).toHaveBeenCalledWith({ videoId: VIDEO });
    expect(service.startScenario).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: VIDEO, targetSeconds: 30, run: { cliId: null } }),
    );
  });

  it('turns a bad brief down before creating anything', async () => {
    const { call, service } = setup();
    await expect(call('studio.create', { brief: '  ' })).rejects.toThrow('what the video is about');
    await expect(
      call('studio.create', { brief: 'x', aspect: '2:1', language: 'en', seconds: 30 }),
    ).rejects.toThrow('language and shape');
    expect(service.create).not.toHaveBeenCalled();
  });

  it('shows scenes, the live run and its last lines', async () => {
    const { call, service, emit } = setup();
    service.generations.mockResolvedValue([run()]);
    emit({ type: 'generation-output', videoId: VIDEO, generationId: 'g1', lines: ['one', 'two'] });

    const detail = (await call('studio.video', { videoId: VIDEO })) as never as Record<
      string,
      never
    >;

    expect(detail.scenes).toHaveLength(2);
    expect(detail.scenes[1]).toMatchObject({ id: 'b', thumbnail: null });
    expect(detail.run).toMatchObject({
      cliName: 'Claude Code',
      repairs: 1,
      lines: ['one', 'two'],
      elapsedMs: 10_000,
    });
  });

  it('keeps only the last lines of a run', async () => {
    const { call, service, emit } = setup();
    service.generations.mockResolvedValue([run()]);
    emit({
      type: 'generation-output',
      videoId: VIDEO,
      generationId: 'g1',
      lines: Array.from({ length: 20 }, (_, i) => `l${i}`),
    });

    const detail = (await call('studio.video', { videoId: VIDEO })) as never as {
      run: { lines: string[] };
    };

    expect(detail.run.lines).toEqual(['l14', 'l15', 'l16', 'l17', 'l18', 'l19']);
  });

  it('puts a proposal in before and after form', async () => {
    const { call, service } = setup();
    service.generations.mockResolvedValue([
      run({
        status: 'proposed',
        proposal: {
          summary: 'Shorter intro',
          changes: [
            { kind: 'title', before: 'A', after: 'B' },
            {
              kind: 'scene-changed',
              title: 'One',
              changes: [{ label: 'Narration', before: 'x', after: 'y' }],
            },
            { kind: 'scene-removed', title: 'Two' },
          ],
        },
      }),
    ]);

    const detail = (await call('studio.video', { videoId: VIDEO })) as never as {
      proposal: unknown;
    };

    expect(detail.proposal).toEqual({
      generationId: 'g1',
      summary: 'Shorter intro',
      changes: [
        { title: 'Title', fields: [{ label: 'Title', before: 'A', after: 'B' }] },
        { title: 'One', fields: [{ label: 'Narration', before: 'x', after: 'y' }] },
        { title: 'Remove scene: Two', fields: [] },
      ],
    });
  });

  it('animates the scenes in turn, on the computer, and stops at the end', async () => {
    const { call, service, emit } = setup();
    await call('studio.animateAll', { videoId: VIDEO });
    expect(service.startScene).toHaveBeenCalledWith(expect.objectContaining({ sceneId: 'b' }));

    service.generations.mockResolvedValue([run({ status: 'done' })]);
    service.hold.mockResolvedValue(
      session([scene('a', 'f'.repeat(64)), scene('b', 'e'.repeat(64))]),
    );
    emit({ type: 'generation-changed', videoId: VIDEO, generationId: 'g1' });
    await vi.waitFor(() => expect(service.generations).toHaveBeenCalledTimes(2));

    expect(service.startScene).toHaveBeenCalledTimes(1);
    const detail = (await call('studio.video', { videoId: VIDEO })) as never as {
      animatingAll: boolean;
    };
    expect(detail.animatingAll).toBe(false);
  });

  it('stops animating when a scene fails, and says so', async () => {
    const { call, service, emit } = setup();
    await call('studio.animateAll', { videoId: VIDEO });
    service.generations.mockResolvedValue([run({ status: 'failed', error: 'No' })]);

    emit({ type: 'generation-changed', videoId: VIDEO, generationId: 'g1' });
    await vi.waitFor(async () => {
      const detail = (await call('studio.video', { videoId: VIDEO })) as never as {
        stopped: string | null;
      };
      expect(detail.stopped).toContain('did not work');
    });
    expect(service.startScene).toHaveBeenCalledTimes(1);
  });

  it('stopping the run ends the whole queue', async () => {
    const { call, service } = setup();
    await call('studio.animateAll', { videoId: VIDEO });
    await call('studio.cancelRun', { videoId: VIDEO, generationId: 'g1' });

    expect(service.cancelGeneration).toHaveBeenCalledWith({ videoId: VIDEO, generationId: 'g1' });
    const detail = (await call('studio.video', { videoId: VIDEO })) as never as {
      animatingAll: boolean;
    };
    expect(detail.animatingAll).toBe(false);
  });

  it('leaving lets go of the video', async () => {
    const { call, service } = setup();
    await call('studio.video', { videoId: VIDEO });
    await call('studio.leave', { videoId: VIDEO });
    expect(service.release).toHaveBeenCalledWith({ videoId: VIDEO });
  });

  it('holds a video that is still being animated when the phone leaves', async () => {
    const { call, service } = setup();
    await call('studio.animateAll', { videoId: VIDEO });
    await call('studio.leave', { videoId: VIDEO });
    expect(service.release).not.toHaveBeenCalled();
  });

  it('lets go by itself when a phone goes quiet', async () => {
    vi.useFakeTimers();
    const { call, service, tick } = setup();
    await call('studio.video', { videoId: VIDEO });

    tick(HOLD_MS + 1);
    await vi.advanceTimersByTimeAsync(HOLD_MS / 3);

    expect(service.release).toHaveBeenCalledWith({ videoId: VIDEO });
  });

  it('saves the chosen quality before rendering', async () => {
    const { call, service } = setup();
    await call('studio.render', { videoId: VIDEO, quality: 'draft' });
    expect(service.apply).toHaveBeenCalledWith(
      expect.objectContaining({ ops: [{ op: 'render.set', patch: { quality: 'draft' } }] }),
    );
    expect(service.startRender).toHaveBeenCalledWith({ videoId: VIDEO });
  });

  it('leaves the settings alone when the quality is already set', async () => {
    const { call, service } = setup();
    await call('studio.render', { videoId: VIDEO, quality: 'standard' });
    expect(service.apply).not.toHaveBeenCalled();
  });

  it('refuses an unknown quality', async () => {
    const { call, service } = setup();
    await expect(call('studio.render', { videoId: VIDEO, quality: 'huge' })).rejects.toThrow(
      'quality',
    );
    expect(service.startRender).not.toHaveBeenCalled();
  });

  it('passes on why a render cannot start', async () => {
    const { call } = setup();
    await expect(call('studio.renderEstimate', { videoId: VIDEO })).resolves.toMatchObject({
      ok: false,
      problems: ['Animate every scene first.'],
    });
  });

  it('only fetches pictures by their hash', async () => {
    const { call, service } = setup();
    await expect(call('studio.thumbnail', { videoId: VIDEO, hash: '../x' })).rejects.toThrow(
      'not a picture',
    );
    await expect(
      call('studio.thumbnail', { videoId: VIDEO, hash: 'a'.repeat(64) }),
    ).resolves.toEqual({ png: 'AQI=' });
    expect(service.thumbnail).toHaveBeenCalledTimes(1);
  });

  it("turns Studio's own errors into words for the phone", async () => {
    const { call, service } = setup();
    service.startEdit.mockRejectedValue(new Error('An AI run is already working.'));
    await expect(
      call('studio.ask', { videoId: VIDEO, instruction: 'Shorter' }),
    ).rejects.toMatchObject({
      code: 'failed',
      message: 'An AI run is already working.',
    });
  });
});

const PHONE = { phone: { key: 'phone-1' } } as never;

describe('voice from a phone', () => {
  it('gives the price of speaking the chosen scenes', async () => {
    const { call } = setup();
    await expect(
      call('studio.voiceEstimate', {
        videoId: VIDEO,
        sceneIds: ['a', 'b'],
        voiceRef: 'openai:alloy',
      }),
    ).resolves.toEqual({ chars: 10, usd: 0.15, costKnown: true });
  });

  it('refuses to speak at a price the person did not see', async () => {
    const { call, service } = setup();
    await expect(
      call('studio.speak', {
        videoId: VIDEO,
        sceneIds: ['a', 'b'],
        voiceRef: 'openai:alloy',
        confirmedUsd: 0.01,
      }),
    ).rejects.toThrow('price changed');
    expect(service.speak).not.toHaveBeenCalled();
  });

  it('speaks once the price agrees', async () => {
    const { call, service } = setup();
    await call('studio.speak', {
      videoId: VIDEO,
      sceneIds: ['a', 'b'],
      voiceRef: 'openai:alloy',
      confirmedUsd: 0.15,
    });
    expect(service.speak).toHaveBeenCalledWith({
      videoId: VIDEO,
      sceneIds: ['a', 'b'],
      voiceRef: 'openai:alloy',
    });
  });

  it('wants agreement when an online voice has no known price', async () => {
    const { call, service } = setup();
    await expect(
      call('studio.speak', { videoId: VIDEO, sceneIds: ['a'], voiceRef: 'gemini:kore' }),
    ).rejects.toThrow('no known price');
    await call('studio.speak', {
      videoId: VIDEO,
      sceneIds: ['a'],
      voiceRef: 'gemini:kore',
      acceptUnknownCost: true,
    });
    expect(service.speak).toHaveBeenCalledTimes(1);
  });

  it('counts a voice on this computer as free', async () => {
    const { call } = setup();
    await expect(
      call('studio.voiceEstimate', { videoId: VIDEO, sceneIds: ['a'], voiceRef: 'piper:amy' }),
    ).resolves.toMatchObject({ usd: 0, costKnown: true });
  });
});

describe('the timeline from a phone', () => {
  it('lists tracks and clips with readable names', async () => {
    const { call } = setup();
    const timeline = (await call('studio.timeline', { videoId: VIDEO })) as never as {
      seq: number;
      clips: { label: string }[];
    };
    expect(timeline.seq).toBe(4);
    expect(timeline.clips.map((clip) => clip.label)).toEqual(['Song.mp3', 'Hello']);
  });

  it('changes a clip on the version the phone saw', async () => {
    const { call, service } = setup();
    await call('studio.clipEdit', {
      videoId: VIDEO,
      baseSeq: 4,
      clipId: 'c1',
      action: 'set',
      gain: 0.5,
    });
    expect(service.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        baseSeq: 4,
        ops: [expect.objectContaining({ op: 'clip.update', clipId: 'c1' })],
      }),
    );
  });

  it('says so when the video moved on', async () => {
    const { call, service } = setup();
    service.apply.mockResolvedValue({ ok: false } as never);
    await expect(
      call('studio.clipEdit', {
        videoId: VIDEO,
        baseSeq: 1,
        clipId: 'c1',
        action: 'set',
        gain: 0.5,
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('leaves a locked track alone', async () => {
    const { call, service } = setup();
    await expect(
      call('studio.clipEdit', { videoId: VIDEO, baseSeq: 4, clipId: 'c2', action: 'remove' }),
    ).rejects.toThrow('locked');
    expect(service.apply).not.toHaveBeenCalled();
  });

  it('offers only its own gestures', async () => {
    const { call } = setup();
    await expect(
      call('studio.clipEdit', { videoId: VIDEO, baseSeq: 4, clipId: 'c1', action: 'doc.replace' }),
    ).rejects.toThrow('not offered');
  });

  it('adds music only from what the video already has', async () => {
    const { call, service } = setup();
    await expect(
      call('studio.addMusic', { videoId: VIDEO, baseSeq: 4, hash: 'z'.repeat(64) }),
    ).rejects.toThrow('not in this video');
    await call('studio.addMusic', { videoId: VIDEO, baseSeq: 4, hash: 'a'.repeat(64) });
    expect(service.apply).toHaveBeenCalledTimes(1);
  });
});

describe('downloading a video', () => {
  const done = { id: 'r1', status: 'done', output: 'C:/videos/Launch.mp4', nonCommercial: [] };

  function sink() {
    return { event: vi.fn(), binary: vi.fn(), end: vi.fn() };
  }

  function open(world: ReturnType<typeof setup>) {
    world.service.renderJobs.mockResolvedValue([done]);
    return (
      world.downloads.calls['studio.downloadOpen'] as never as (
        p: unknown,
        c: unknown,
      ) => Promise<{ downloadId: string; fileName: string; bytes: number }>
    )({ jobId: 'r1' }, PHONE);
  }

  function read(world: ReturnType<typeof setup>, params: unknown, out = sink(), context = PHONE) {
    return (
      world.downloads.streams['studio.downloadRead'] as never as (
        p: unknown,
        s: unknown,
        c: unknown,
      ) => Promise<unknown>
    )(params, out, context);
  }

  it('opens from the render record and keeps the path to itself', async () => {
    const world = setup();
    const opened = await open(world);
    expect(opened).toMatchObject({ fileName: 'Launch.mp4', bytes: 10 });
    expect(JSON.stringify(opened)).not.toContain('C:/videos');
  });

  it('refuses a render that has not finished', async () => {
    const world = setup();
    world.service.renderJobs.mockResolvedValue([{ ...done, status: 'running', output: null }]);
    await expect(
      (
        world.downloads.calls['studio.downloadOpen'] as never as (
          p: unknown,
          c: unknown,
        ) => Promise<unknown>
      )({ jobId: 'r1' }, PHONE),
    ).rejects.toThrow('no finished file');
  });

  it('sends one piece and ends', async () => {
    const world = setup();
    const { downloadId } = await open(world);
    const out = sink();
    await read(world, { downloadId, offset: 0, length: 2 }, out);
    expect(world.files.read).toHaveBeenCalledWith('C:/videos/Launch.mp4', 0, 2);
    expect(out.binary).toHaveBeenCalledTimes(1);
    expect(out.end).toHaveBeenCalledTimes(1);
  });

  it("won't read for another phone", async () => {
    const world = setup();
    const { downloadId } = await open(world);
    await expect(
      read(world, { downloadId, offset: 0, length: 2 }, sink(), {
        phone: { key: 'other' },
      } as never),
    ).rejects.toThrow('has ended');
  });

  it('refuses a piece too big to send safely', async () => {
    const world = setup();
    const { downloadId } = await open(world);
    await expect(read(world, { downloadId, offset: 0, length: 2_000_000 })).rejects.toThrow(
      'not valid',
    );
  });

  it('stops if the file changes underneath it', async () => {
    const world = setup();
    const { downloadId } = await open(world);
    world.files.stat.mockResolvedValue({ size: 10, mtimeMs: 99 });
    await expect(read(world, { downloadId, offset: 0, length: 2 })).rejects.toThrow('changed');
  });
});
