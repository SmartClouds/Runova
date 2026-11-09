import { describe, expect, it } from 'vitest';
import { createDocument, createScene, MAX_SHOT_STEPS } from '../../document/schema.js';
import { localAppUrl, readPicturesAnswer } from './answer.js';
import { buildPicturesRequest } from './prompt.js';

function doc() {
  const d = createDocument({ id: 'v1', title: 'Launch', language: 'en', aspect: '16:9' });
  d.scenario.scenes = [
    createScene({ id: 's1', title: 'Settings', narration: 'Set it up once.' }),
    createScene({
      id: 's2',
      title: 'Result',
      pictures: [
        {
          id: 'old-ready',
          purpose: 'The dashboard.',
          source: 'screenshot',
          status: 'ready',
          shot: { target: 'route', path: '/', viewport: 'desktop' },
          fileName: 'scene-02-dashboard.png',
          mediaHash: 'a'.repeat(64),
          error: null,
        },
        {
          id: 'old-planned',
          purpose: 'Old idea.',
          source: 'file',
          status: 'planned',
          prompt: 'x',
          fileName: 'scene-02-old.png',
          mediaHash: null,
          error: null,
        },
      ],
    }),
  ];
  return d;
}

let n = 0;
const options = { hasProject: true, canGenerate: true, newId: () => `p${++n}` };

const ANSWER = {
  app: { kind: 'web', runCommandId: 'dev', url: 'http://0.0.0.0:5173/' },
  scenes: [
    {
      sceneId: 's1',
      pictures: [
        {
          purpose: 'The settings page with the AI tab open.',
          label: 'Settings page',
          source: 'screenshot',
          shot: { path: '/settings', steps: [{ do: 'click', selector: '#ai-tab' }] },
        },
        {
          purpose: 'A calm desk.',
          label: 'Desk',
          source: 'generate',
          prompt: 'A calm desk at dawn, no text.',
        },
      ],
    },
  ],
};

describe('reading the Pictures answer', () => {
  it('turns the plan into edits, keeping ready pictures and replacing the rest', () => {
    const read = readPicturesAnswer(JSON.stringify(ANSWER), doc(), options);
    if (!read.ok) throw new Error(read.issues.join('; '));
    expect(read.value.count).toBe(2);
    expect(read.value.app).toEqual({
      kind: 'web',
      runCommandId: 'dev',
      url: 'http://localhost:5173',
    });
    const [first, second] = read.value.ops;
    expect(first).toMatchObject({ op: 'scene.update', sceneId: 's1' });
    const pictures = first?.op === 'scene.update' ? (first.patch.pictures ?? []) : [];
    expect(pictures.map((p) => [p.source, p.status, p.fileName])).toEqual([
      ['screenshot', 'planned', 'scene-01-settings-page.png'],
      ['generate', 'planned', 'scene-01-desk.png'],
    ]);
    // A shot without a target is a route shot, at the desktop size.
    expect(pictures[0]?.shot).toEqual({
      target: 'route',
      path: '/settings',
      steps: [{ do: 'click', selector: '#ai-tab' }],
      viewport: 'desktop',
    });
    // Scene 2 was not answered: its ready picture stays and the old plan goes.
    expect(second).toMatchObject({ op: 'scene.update', sceneId: 's2' });
    const kept = second?.op === 'scene.update' ? second.patch.pictures : [];
    expect(kept?.map((p) => p.id)).toEqual(['old-ready']);
  });

  it("makes a generated picture the user's file when no image model is set up", () => {
    const read = readPicturesAnswer(JSON.stringify(ANSWER), doc(), {
      ...options,
      canGenerate: false,
    });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const first = read.value.ops[0];
    const pictures = first?.op === 'scene.update' ? (first.patch.pictures ?? []) : [];
    expect(pictures[1]).toMatchObject({ source: 'file', prompt: 'A calm desk at dawn, no text.' });
  });

  it('asks for a fix when a screenshot has no project, or a scene does not exist', () => {
    const read = readPicturesAnswer(
      JSON.stringify({ ...ANSWER, scenes: [...ANSWER.scenes, { sceneId: 'nope', pictures: [] }] }),
      doc(),
      { ...options, hasProject: false },
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.issues).toContain('There is no scene with the sceneId "nope".');
    expect(read.issues.some((i) => i.includes('there is no project'))).toBe(true);
  });

  it('says what is wrong with an answer that is not the plan', () => {
    const prose = readPicturesAnswer('Sorry, I could not look at the project.', doc(), options);
    expect(prose.ok).toBe(false);
    const wrongShape = readPicturesAnswer(JSON.stringify({ scenes: 'none' }), doc(), options);
    expect(wrongShape.ok).toBe(false);
    if (wrongShape.ok) return;
    expect(wrongShape.issues.length).toBeGreaterThan(0);
  });

  it('asks for a fix when a screenshot has no shot or a generated picture no prompt', () => {
    const read = readPicturesAnswer(
      JSON.stringify({
        scenes: [
          {
            sceneId: 's1',
            pictures: [
              { purpose: 'The home page.', label: 'Home', source: 'screenshot' },
              { purpose: 'A calm desk.', label: 'Desk', source: 'generate' },
            ],
          },
        ],
      }),
      doc(),
      options,
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.issues).toEqual([
      'Scene "s1", picture 1 is a screenshot without a "shot" saying how to take it.',
      'Scene "s1", picture 2 is generated but has no "prompt".',
    ]);
  });

  it('keeps a mobile shot, a window shot, and only as many steps as a shot can hold', () => {
    const steps = Array.from({ length: MAX_SHOT_STEPS + 3 }, () => ({
      do: 'click',
      selector: '#next',
    }));
    const read = readPicturesAnswer(
      JSON.stringify({
        scenes: [
          {
            sceneId: 's1',
            pictures: [
              {
                purpose: 'The phone layout.',
                label: 'Phone',
                source: 'screenshot',
                shot: { path: '/', viewport: 'mobile', steps },
              },
              {
                purpose: 'The desktop app.',
                label: 'Window',
                source: 'screenshot',
                shot: { target: 'window', instructions: 'Open the settings window.' },
              },
            ],
          },
        ],
      }),
      doc(),
      options,
    );
    if (!read.ok) throw new Error(read.issues.join('; '));
    const first = read.value.ops[0];
    const pictures = first?.op === 'scene.update' ? (first.patch.pictures ?? []) : [];
    expect(pictures[0]?.shot).toMatchObject({ target: 'route', viewport: 'mobile' });
    const shot = pictures[0]?.shot;
    expect(shot?.target === 'route' ? shot.steps : []).toHaveLength(MAX_SHOT_STEPS);
    expect(pictures[1]?.shot).toEqual({
      target: 'window',
      instructions: 'Open the settings window.',
    });
  });

  it('uses the purpose as the prompt when a file picture has none', () => {
    const read = readPicturesAnswer(
      JSON.stringify({
        scenes: [
          {
            sceneId: 's1',
            pictures: [{ purpose: 'Your team photo.', label: 'Team', source: 'file' }],
          },
        ],
      }),
      doc(),
      options,
    );
    if (!read.ok) throw new Error(read.issues.join('; '));
    const first = read.value.ops[0];
    const pictures = first?.op === 'scene.update' ? (first.patch.pictures ?? []) : [];
    expect(pictures[0]).toMatchObject({ source: 'file', prompt: 'Your team photo.' });
  });

  it('leaves a scene alone when there is nothing to change', () => {
    const video = doc();
    const [, result] = video.scenario.scenes;
    if (result) result.pictures = result.pictures?.filter((p) => p.status === 'ready');
    const read = readPicturesAnswer(JSON.stringify({ scenes: [] }), video, options);
    if (!read.ok) throw new Error(read.issues.join('; '));
    expect(read.value).toMatchObject({ ops: [], count: 0 });
  });

  it('only opens local addresses', () => {
    expect(localAppUrl('http://127.0.0.1:3000/app')).toBe('http://127.0.0.1:3000');
    expect(localAppUrl('https://example.com')).toBeNull();
    expect(localAppUrl('file:///etc/passwd')).toBeNull();
    expect(localAppUrl('nonsense')).toBeNull();
  });
});

describe('the Pictures request', () => {
  it('tells the AI it may read the project but not change or run it', () => {
    const text = buildPicturesRequest({
      document: doc(),
      project: {
        name: 'Shop',
        folderPath: 'E:\\shop',
        runCommands: [{ id: 'dev', label: 'dev', command: 'npm run dev' }],
      },
      imageModel: 'GPT Image',
    });
    expect(text).toContain('## The project: Shop');
    expect(text).toContain(
      'Only read: do not change, create or delete any file, and do not run anything.',
    );
    expect(text).toContain('- id "dev" (dev): `npm run dev`');
    expect(text).toContain('"generate": a picture made by GPT Image');
    expect(text).toContain('"readyPictures": [\n   "The dashboard."\n  ]');
  });

  it('leaves screenshots and generation out when there is neither', () => {
    const text = buildPicturesRequest({ document: doc(), project: null, imageModel: null });
    expect(text).not.toContain('"screenshot": a real screen');
    expect(text).not.toContain('"generate": a picture made by');
    expect(text).toContain('In "app", give kind "none".');
  });
});
