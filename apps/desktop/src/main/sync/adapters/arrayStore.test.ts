import { syncCollection } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { arrayStoreAdapter } from './arrayStore';

interface Note {
  id: string;
  name: string;
}

function adapter(initial: Note[]) {
  let items = structuredClone(initial);
  return {
    adapter: arrayStoreAdapter<Note>({
      collection: syncCollection('prompt-templates'),
      area: 'prompts',
      read: async () => structuredClone(items),
      write: async (next) => {
        items = structuredClone(next);
      },
      id: (item) => item.id,
    }),
    get: () => items,
  };
}

describe('arrayStoreAdapter', () => {
  it('stores an item under the id it is applied with, as "Keep both" adds a copy under a new one', async () => {
    const { adapter: notes, get } = adapter([{ id: 'a', name: 'Mine' }]);

    // The engine hands the other computer's value, its id still the original's, under a new id.
    await notes.apply({ id: 'copy', teamId: null, value: { id: 'a', name: 'Theirs' } });

    expect(get()).toEqual([
      { id: 'a', name: 'Mine' },
      { id: 'copy', name: 'Theirs' },
    ]);
  });
});
