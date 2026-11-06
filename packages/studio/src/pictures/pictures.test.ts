import { describe, expect, it } from 'vitest';
import { applyOps } from '../document/ops.js';
import { createDocument, createScene, type ScenePicture } from '../document/schema.js';
import { picturesMarkdown } from './markdown.js';
import {
  imageSizeFor,
  pendingPictures,
  pictureCounts,
  pictureFileName,
  slugify,
  updatePictureOp,
} from './pictures.js';

const picture = (over: Partial<ScenePicture> & Pick<ScenePicture, 'id'>): ScenePicture => ({
  purpose: 'The settings page, pointing at the AI tab.',
  source: 'screenshot',
  status: 'planned',
  shot: { target: 'route', path: '/settings', viewport: 'desktop' },
  fileName: `scene-01-${over.id}.png`,
  mediaHash: null,
  genJobId: null,
  error: null,
  ...over,
});

function doc() {
  const d = createDocument({ id: 'v1', title: 'Launch', language: 'en', aspect: '16:9' });
  d.scenario.scenes = [
    createScene({
      id: 's1',
      title: 'Settings',
      pictures: [
        picture({ id: 'a' }),
        picture({
          id: 'b',
          source: 'generate',
          shot: undefined,
          prompt: 'A calm desk at dawn, no text.',
        }),
      ],
    }),
    createScene({
      id: 's2',
      title: 'Done',
      pictures: [picture({ id: 'c', status: 'ready', mediaHash: 'f'.repeat(64) })],
    }),
    createScene({ id: 's3', title: 'Old scene' }),
  ];
  return d;
}

describe('pictures', () => {
  it('counts what is ready and what each kind of source still has to make', () => {
    expect(pictureCounts(doc())).toEqual({
      total: 3,
      ready: 1,
      failed: 0,
      screenshots: 1,
      routeShots: 1,
      windowShots: 0,
      generate: 1,
      files: 0,
    });
    expect(pendingPictures(doc()).map((p) => p.picture.id)).toEqual(['a', 'b']);
  });

  it('names files by scene and label, never twice', () => {
    expect(slugify('  Settings page / AI tab! ')).toBe('settings-page-ai-tab');
    expect(slugify('صفحه')).toBe('picture');
    const taken = new Set(['scene-03-settings.png']);
    expect(pictureFileName(2, 'Settings', taken)).toBe('scene-03-settings-2.png');
  });

  it('picks the image size from the shape of the video', () => {
    expect(imageSizeFor('16:9')).toBe('1536x1024');
    expect(imageSizeFor('9:16')).toBe('1024x1536');
    expect(imageSizeFor('1:1')).toBe('1024x1024');
  });

  it('changes one picture with an edit that undoes back to how it was', () => {
    const before = doc();
    const scene = before.scenario.scenes[0]!;
    const { document: after, inverse } = applyOps(before, [
      updatePictureOp(scene, 'a', { status: 'failed', error: 'Nothing answered.' }),
    ]);
    expect(after.scenario.scenes[0]?.pictures?.[0]).toMatchObject({ status: 'failed' });
    const { document: back } = applyOps(after, inverse);
    expect(back).toEqual(before);
  });

  it('undoes the first pictures of a scene from before the Pictures step to none', () => {
    const before = doc();
    const { document: after, inverse } = applyOps(before, [
      { op: 'scene.update', sceneId: 's3', patch: { pictures: [picture({ id: 'd' })] } },
    ]);
    expect(after.scenario.scenes[2]?.pictures).toHaveLength(1);
    // The inverse survives JSON, as the history keeps it.
    const { document: back } = applyOps(after, JSON.parse(JSON.stringify(inverse)));
    expect(back.scenario.scenes[2]?.pictures).toEqual([]);
  });

  it('writes PICTURES.md with each missing picture, its file name and how to make it', () => {
    const text = picturesMarkdown(doc());
    expect(text).toContain('# Pictures for "Launch"');
    expect(text).toContain('2 pictures are still needed.');
    expect(text).toContain('## Scene 1: Settings');
    expect(text).toContain('`scene-01-a.png`');
    expect(text).toContain('**Screenshot of:** `/settings` in the app, at 1440x900.');
    expect(text).toContain('```text\nA calm desk at dawn, no text.\n```');
    expect(text).toContain('**Size:** 1536x1024 (16:9)');
    // Ready pictures are not listed.
    expect(text).not.toContain('scene-01-c.png');
  });
});
