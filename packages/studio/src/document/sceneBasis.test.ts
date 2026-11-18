import { describe, expect, it } from 'vitest';
import { secondsToFlicks } from '../time/flicks.js';
import { sceneBasis, sceneBasisChanges } from './sceneBasis.js';
import { createScene, type Scene, type ScenePicture } from './schema.js';

const TREE = 'a'.repeat(64);

function picture(overrides: Partial<ScenePicture> = {}): ScenePicture {
  return {
    id: 'p1',
    purpose: 'hero',
    status: 'ready',
    source: 'generate',
    fileName: 'hero.png',
    mediaHash: 'b'.repeat(64),
    error: null,
    ...overrides,
  } as ScenePicture;
}

function animated(overrides: Partial<Scene> = {}): Scene {
  const scene = createScene({
    id: 's1',
    title: 'Hook',
    narration: 'Ready for something different?',
    onScreenText: ['Bit Iron'],
    visualBrief: 'Deep navy background.',
    targetDuration: secondsToFlicks(3.9),
    pictures: [picture()],
  });
  return { ...scene, code: { treeHash: TREE, basis: sceneBasis(scene) }, ...overrides };
}

describe('sceneBasis', () => {
  it('gives the same basis for the same fields', () => {
    expect(sceneBasis(animated())).toEqual(sceneBasis(animated()));
  });

  it('keeps every part short enough to store', () => {
    for (const value of Object.values(sceneBasis(animated()))) {
      expect(value).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

describe('sceneBasisChanges', () => {
  it('finds nothing when the scene is as it was animated', () => {
    expect(sceneBasisChanges(animated())).toEqual([]);
  });

  it.each<[string, Partial<Scene>]>([
    ['title', { title: 'Opening' }],
    ['narration', { narration: 'Something new.' }],
    ['onScreenText', { onScreenText: ['Bit Iron', 'Now faster'] }],
    ['visualBrief', { visualBrief: 'A white background.' }],
    ['length', { targetDuration: secondsToFlicks(6) }],
    ['pictures', { pictures: [picture({ mediaHash: 'c'.repeat(64) })] }],
  ])('names %s once it changed', (field, patch) => {
    expect(sceneBasisChanges(animated(patch))).toEqual([field]);
  });

  it('names every field that changed, in the order the card shows them', () => {
    expect(
      sceneBasisChanges(animated({ targetDuration: secondsToFlicks(8), narration: 'New words.' })),
    ).toEqual(['narration', 'length']);
  });

  it('ignores a length change too small to reach the AI', () => {
    expect(sceneBasisChanges(animated({ targetDuration: secondsToFlicks(3.91) }))).toEqual([]);
  });

  it('ignores pictures that are not ready yet', () => {
    const planned = picture({
      id: 'p2',
      fileName: 'chart.png',
      status: 'planned',
      mediaHash: null,
    });
    expect(sceneBasisChanges(animated({ pictures: [picture(), planned] }))).toEqual([]);
  });

  it('ignores fields the animation is not made from', () => {
    expect(
      sceneBasisChanges(
        animated({
          transitionOut: { kind: 'dissolve', duration: secondsToFlicks(0.5) },
          notes: 'Check with the team',
          musicCue: 'upbeat',
        } as Partial<Scene>),
      ),
    ).toEqual([]);
  });

  it('finds nothing without an animation or without a record of what it was made from', () => {
    expect(sceneBasisChanges(createScene({ id: 's1', narration: 'x' }))).toEqual([]);
    expect(
      sceneBasisChanges({ ...animated({ narration: 'Changed' }), code: { treeHash: TREE } }),
    ).toEqual([]);
    expect(
      sceneBasisChanges({
        ...animated({ narration: 'Changed' }),
        code: { treeHash: TREE, basis: null },
      }),
    ).toEqual([]);
  });
});
