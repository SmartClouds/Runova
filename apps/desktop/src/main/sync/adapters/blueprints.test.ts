import { createBlankBlueprint, type ProjectBlueprint } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { blueprintsAdapter } from './blueprints';

const attachment = {
  id: 'a1',
  fileName: 'a1.png',
  displayName: 'Mockup',
  mime: 'image/png',
  size: 10,
  createdAt: '2026-11-01T00:00:00.000Z',
};

function blueprint(): ProjectBlueprint {
  const value = createBlankBlueprint('b1', 'p1');
  value.sections[0] = { ...value.sections[0], text: 'A shop', attachments: [attachment] } as never;
  return value;
}

function memoryStore(initial: ProjectBlueprint[] = []) {
  let blueprints = structuredClone(initial);
  return {
    getBlueprints: async () => structuredClone(blueprints),
    setBlueprints: async (next: ProjectBlueprint[]) => {
      blueprints = structuredClone(next);
    },
    get: () => blueprints,
  };
}

describe('blueprintsAdapter', () => {
  it('leaves attachments out of what syncs, as their files stay on this computer', async () => {
    const [item] = await blueprintsAdapter(memoryStore([blueprint()])).list();
    const sections = item?.value.sections as Record<string, unknown>[];

    expect(sections[0]?.text).toBe('A shop');
    for (const section of sections) expect(section).not.toHaveProperty('attachments');
  });

  it('keeps this computer’s attachments on each step when the text changes elsewhere', async () => {
    const store = memoryStore([blueprint()]);
    const [item] = await blueprintsAdapter(memoryStore([blueprint()])).list();
    if (!item) throw new Error('missing');
    const sections = (item.value.sections as Record<string, unknown>[]).map((section, index) =>
      index === 0 ? { ...section, text: 'A bigger shop' } : section,
    );

    await blueprintsAdapter(store).apply({
      id: 'b1',
      teamId: null,
      value: { ...item.value, sections },
    });

    const first = store.get()[0]?.sections[0];
    expect(first?.text).toBe('A bigger shop');
    expect(first?.attachments).toEqual([attachment]);
  });

  it('adds a blueprint from another computer with no attachments', async () => {
    const store = memoryStore();
    const [item] = await blueprintsAdapter(memoryStore([blueprint()])).list();

    await blueprintsAdapter(store).apply(item as never);

    expect(store.get()[0]?.sections.every((section) => section.attachments.length === 0)).toBe(
      true,
    );
  });
});
