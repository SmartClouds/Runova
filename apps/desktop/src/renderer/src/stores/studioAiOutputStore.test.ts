import type { GenerationView } from '@runova/studio';
import { describe, expect, it } from 'vitest';
import { MAX_OUTPUT_LINES, useStudioAiOutputStore } from './studioAiOutputStore';

const run = (id: string, status: GenerationView['status'], stage: GenerationView['stage']) =>
  ({ id, status, stage }) as GenerationView;

describe('studioAiOutputStore', () => {
  it('keeps the latest lines of each run, per video', () => {
    const { append } = useStudioAiOutputStore.getState();
    append('v1', 'g1', ['one', 'two']);
    append('v1', 'g1', ['three']);
    append('v2', 'g1', ['elsewhere']);
    append(
      'v1',
      'g2',
      Array.from({ length: MAX_OUTPUT_LINES + 5 }, (_, i) => `line ${i}`),
    );
    const { output } = useStudioAiOutputStore.getState();
    expect(output.v1?.g1).toEqual(['one', 'two', 'three']);
    expect(output.v2?.g1).toEqual(['elsewhere']);
    expect(output.v1?.g2).toHaveLength(MAX_OUTPUT_LINES);
    expect(output.v1?.g2?.at(-1)).toBe(`line ${MAX_OUTPUT_LINES + 4}`);
  });

  it('tells once about a scenario that finished since it was last seen running', () => {
    const { observe } = useStudioAiOutputStore.getState();
    expect(observe([run('g1', 'running', 'scenario'), run('g2', 'running', 'edit')])).toEqual([]);
    // Seen again later, as when the editor opens after the user was on another page.
    const finished = observe([run('g1', 'done', 'scenario'), run('g2', 'proposed', 'edit')]);
    expect(finished.map((g) => g.id)).toEqual(['g1']);
    expect(observe([run('g1', 'done', 'scenario')])).toEqual([]);
    // A run first seen already done was not watched, so there is nothing to tell.
    expect(observe([run('g3', 'done', 'scenario')])).toEqual([]);
  });
});
