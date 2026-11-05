import { describe, expect, it } from 'vitest';
import { canonicalJson, planPull, planPush, type SyncedState } from './plan.js';

const synced = (hash: string | null, revision: number): SyncedState => ({ hash, revision });

describe('canonicalJson', () => {
  it('sorts keys at every depth, so the same data always gives the same text', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('drops undefined fields like JSON does, but keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe('planPull', () => {
  it('applies a new remote item that is not here yet', () => {
    const plan = planPull({
      local: new Map(),
      synced: new Map(),
      remote: [{ itemId: 'a', revision: 3, deleted: false, hash: 'h1' }],
    });

    expect(plan.apply).toEqual([{ itemId: 'a', revision: 3, deleted: false, hash: 'h1' }]);
    expect(plan.conflicts).toEqual([]);
  });

  it('applies a remote change over an item that did not change here since the last sync', () => {
    const plan = planPull({
      local: new Map([['a', 'h1']]),
      synced: new Map([['a', synced('h1', 2)]]),
      remote: [{ itemId: 'a', revision: 5, deleted: false, hash: 'h2' }],
    });

    expect(plan.apply.map((r) => r.itemId)).toEqual(['a']);
  });

  it('applies a remote delete of an item that did not change here', () => {
    const plan = planPull({
      local: new Map([['a', 'h1']]),
      synced: new Map([['a', synced('h1', 2)]]),
      remote: [{ itemId: 'a', revision: 5, deleted: true, hash: null }],
    });

    expect(plan.apply).toEqual([{ itemId: 'a', revision: 5, deleted: true, hash: null }]);
  });

  it('ignores a remote delete of something that is not here', () => {
    const plan = planPull({
      local: new Map(),
      synced: new Map(),
      remote: [{ itemId: 'a', revision: 5, deleted: true, hash: null }],
    });

    expect(plan.apply).toEqual([]);
    expect(plan.settle).toEqual([{ itemId: 'a', revision: 5, hash: null }]);
  });

  it('only records the revision when both sides already hold the same content', () => {
    const plan = planPull({
      local: new Map([['a', 'h2']]),
      synced: new Map([['a', synced('h1', 2)]]),
      remote: [{ itemId: 'a', revision: 5, deleted: false, hash: 'h2' }],
    });

    expect(plan.apply).toEqual([]);
    expect(plan.settle).toEqual([{ itemId: 'a', revision: 5, hash: 'h2' }]);
  });

  it('is a conflict when the item changed here and there', () => {
    const plan = planPull({
      local: new Map([['a', 'mine']]),
      synced: new Map([['a', synced('h1', 2)]]),
      remote: [{ itemId: 'a', revision: 5, deleted: false, hash: 'theirs' }],
    });

    expect(plan.apply).toEqual([]);
    expect(plan.conflicts).toEqual([
      { itemId: 'a', revision: 5, deleted: false, hash: 'theirs', localDeleted: false },
    ]);
  });

  it('is a conflict when it was deleted there and changed here', () => {
    const plan = planPull({
      local: new Map([['a', 'mine']]),
      synced: new Map([['a', synced('h1', 2)]]),
      remote: [{ itemId: 'a', revision: 5, deleted: true, hash: null }],
    });

    expect(plan.conflicts.map((c) => c.itemId)).toEqual(['a']);
  });

  it('is a conflict when it was deleted here and changed there', () => {
    const plan = planPull({
      local: new Map(),
      synced: new Map([['a', synced('h1', 2)]]),
      remote: [{ itemId: 'a', revision: 5, deleted: false, hash: 'theirs' }],
    });

    expect(plan.conflicts).toEqual([
      { itemId: 'a', revision: 5, deleted: false, hash: 'theirs', localDeleted: true },
    ]);
  });

  it('settles a delete on both sides without asking', () => {
    const plan = planPull({
      local: new Map(),
      synced: new Map([['a', synced('h1', 2)]]),
      remote: [{ itemId: 'a', revision: 5, deleted: true, hash: null }],
    });

    expect(plan.conflicts).toEqual([]);
    expect(plan.settle).toEqual([{ itemId: 'a', revision: 5, hash: null }]);
  });

  it('is a conflict when the same id was made on both sides with different content', () => {
    const plan = planPull({
      local: new Map([['a', 'mine']]),
      synced: new Map(),
      remote: [{ itemId: 'a', revision: 1, deleted: false, hash: 'theirs' }],
    });

    expect(plan.conflicts.map((c) => c.itemId)).toEqual(['a']);
  });

  it('skips a remote revision it has already seen', () => {
    const plan = planPull({
      local: new Map([['a', 'h1']]),
      synced: new Map([['a', synced('h1', 5)]]),
      remote: [{ itemId: 'a', revision: 5, deleted: false, hash: 'h1' }],
    });

    expect(plan).toEqual({ apply: [], settle: [], conflicts: [] });
  });
});

describe('planPush', () => {
  it('pushes a new item with base revision 0', () => {
    expect(planPush({ local: new Map([['a', 'h1']]), synced: new Map(), held: new Set() })).toEqual(
      [{ itemId: 'a', baseRevision: 0, deleted: false, hash: 'h1' }],
    );
  });

  it('pushes a changed item on the revision it was based on', () => {
    expect(
      planPush({
        local: new Map([['a', 'h2']]),
        synced: new Map([['a', synced('h1', 4)]]),
        held: new Set(),
      }),
    ).toEqual([{ itemId: 'a', baseRevision: 4, deleted: false, hash: 'h2' }]);
  });

  it('pushes a delete for an item that is gone here', () => {
    expect(
      planPush({ local: new Map(), synced: new Map([['a', synced('h1', 4)]]), held: new Set() }),
    ).toEqual([{ itemId: 'a', baseRevision: 4, deleted: true, hash: null }]);
  });

  it('pushes nothing for an unchanged item, a settled delete, or an item held by a conflict', () => {
    expect(
      planPush({
        local: new Map([
          ['a', 'h1'],
          ['c', 'changed'],
        ]),
        synced: new Map([
          ['a', synced('h1', 4)],
          ['b', synced(null, 6)],
          ['c', synced('h1', 2)],
        ]),
        held: new Set(['c']),
      }),
    ).toEqual([]);
  });
});
