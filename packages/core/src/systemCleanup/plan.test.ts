import { describe, expect, it } from 'vitest';
import {
  type PlanItem,
  planEverything,
  planKeepNewest,
  planSelection,
  summarizePlan,
} from './plan.js';

let counter = 0;
function item(group: string, version: string | null, bytes = 100, sharedBytes = 0): PlanItem {
  counter += 1;
  return { id: `i${counter}`, group, groupLabel: group, version, bytes, sharedBytes };
}

const versionsOf = (items: PlanItem[]): string[] =>
  items.map((entry) => `${entry.group}@${entry.version ?? '-'}`);

describe('planKeepNewest', () => {
  it('removes every version but the newest', () => {
    const items = [item('a', '1.0.0'), item('a', '3.0.0'), item('a', '2.0.0')];
    const plan = planKeepNewest(items, { keep: 1 });
    expect(versionsOf(plan.remove)).toEqual(['a@1.0.0', 'a@2.0.0']);
    expect(versionsOf(plan.keep)).toEqual(['a@3.0.0']);
  });

  it('keeps the newest few when asked to', () => {
    const items = ['1.0.0', '2.0.0', '3.0.0', '4.0.0'].map((version) => item('a', version));
    const plan = planKeepNewest(items, { keep: 2 });
    expect(versionsOf(plan.remove)).toEqual(['a@1.0.0', 'a@2.0.0']);
    expect(versionsOf(plan.keep)).toEqual(['a@3.0.0', 'a@4.0.0']);
  });

  it('never removes the only version of something', () => {
    const plan = planKeepNewest([item('a', '1.0.0'), item('b', '9.9.9')], { keep: 1 });
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toHaveLength(2);
  });

  it('judges each group on its own', () => {
    const items = [
      item('a', '1.0.0'),
      item('a', '2.0.0'),
      item('b', '5.0.0'),
      item('b', '4.0.0'),
      item('c', '1.0.0'),
    ];
    const plan = planKeepNewest(items, { keep: 1 });
    expect(versionsOf(plan.remove)).toEqual(['a@1.0.0', 'b@4.0.0']);
  });

  it('also keeps the newest stable release, so one release candidate cannot push it out', () => {
    const items = [item('sdk', '8.0.0'), item('sdk', '9.0.5'), item('sdk', '10.0.0-rc.1')];
    const plan = planKeepNewest(items, { keep: 1 });
    expect(versionsOf(plan.remove)).toEqual(['sdk@8.0.0']);
    expect(versionsOf(plan.keep)).toEqual(['sdk@9.0.5', 'sdk@10.0.0-rc.1']);
  });

  it('keeps the newest as it stands when nothing in the group is stable', () => {
    const items = [item('sdk', '1.0.0-beta.1'), item('sdk', '1.0.0-beta.2')];
    const plan = planKeepNewest(items, { keep: 1 });
    expect(versionsOf(plan.remove)).toEqual(['sdk@1.0.0-beta.1']);
    expect(versionsOf(plan.keep)).toEqual(['sdk@1.0.0-beta.2']);
  });

  it('leaves a whole group alone when one of its versions cannot be put in order', () => {
    const items = [item('tool', '1.0.0'), item('tool', '2.0.0'), item('tool', 'LATEST')];
    const plan = planKeepNewest(items, { keep: 1 });
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toHaveLength(3);
    expect(plan.skipped).toEqual([
      {
        group: 'tool',
        label: 'tool',
        reason: 'The versions could not be put in order, so none were removed.',
      },
    ]);
  });

  it('never removes something that has no version', () => {
    const items = [item('other', null), item('a', '1.0.0'), item('a', '2.0.0')];
    const plan = planKeepNewest(items, { keep: 1 });
    expect(versionsOf(plan.remove)).toEqual(['a@1.0.0']);
    expect(versionsOf(plan.keep)).toContain('other@-');
    expect(plan.skipped).toEqual([]);
  });

  it('puts the same version in two places on the same footing', () => {
    const items = [item('a', '2.0.0'), item('a', '2.0.0'), item('a', '1.0.0')];
    const plan = planKeepNewest(items, { keep: 1 });
    expect(versionsOf(plan.remove)).toEqual(['a@1.0.0']);
    expect(plan.keep).toHaveLength(2);
  });

  it.each([
    [0, 1],
    [-3, 1],
    [Number.NaN, 1],
    [1.9, 1],
    [2, 2],
    [50, 9],
  ])('reads keep %s as %s', (asked, used) => {
    const items = Array.from({ length: 12 }, (_, index) => item('a', `${index + 1}.0.0`));
    const plan = planKeepNewest(items, { keep: asked });
    expect(plan.keep).toHaveLength(used);
    expect(plan.remove).toHaveLength(12 - used);
  });

  it('lists what it removes oldest first within each group, in the order the groups came', () => {
    const items = [item('z', '2.0.0'), item('z', '1.0.0'), item('a', '3.0.0'), item('a', '1.0.0')];
    const plan = planKeepNewest(items, { keep: 1 });
    expect(versionsOf(plan.remove)).toEqual(['z@1.0.0', 'a@1.0.0']);
  });

  it('handles an empty list', () => {
    expect(planKeepNewest([], { keep: 1 })).toEqual({ remove: [], keep: [], skipped: [] });
  });
});

describe('planEverything', () => {
  it('removes all of it, with or without a version', () => {
    const items = [item('a', '1.0.0'), item('other', null)];
    expect(planEverything(items).remove).toEqual(items);
  });
});

describe('planSelection', () => {
  it('removes just the items asked for', () => {
    const items = [item('a', '1.0.0'), item('a', '2.0.0'), item('b', '1.0.0')];
    const plan = planSelection(items, [items[1]?.id ?? '', items[2]?.id ?? '']);
    expect(plan.remove).toEqual([items[1], items[2]]);
    expect(plan.unknown).toEqual([]);
  });

  it('reports an id that is not in the scan instead of ignoring it', () => {
    const items = [item('a', '1.0.0')];
    const plan = planSelection(items, [items[0]?.id ?? '', 'made-up']);
    expect(plan.remove).toEqual(items);
    expect(plan.unknown).toEqual(['made-up']);
  });

  it('counts an id named twice once', () => {
    const items = [item('a', '1.0.0')];
    const id = items[0]?.id ?? '';
    expect(planSelection(items, [id, id]).remove).toHaveLength(1);
  });
});

describe('summarizePlan', () => {
  it('adds up what a plan would remove, and what it would really free', () => {
    const summary = summarizePlan([
      item('a', '1.0.0', 1000, 0),
      item('a', '2.0.0', 500, 200),
      item('b', '1.0.0', 300, 300),
    ]);
    expect(summary).toEqual({
      items: 3,
      groups: 2,
      bytes: 1800,
      sharedBytes: 500,
      freesUpTo: 1300,
    });
  });

  it('is empty for an empty plan', () => {
    expect(summarizePlan([])).toEqual({
      items: 0,
      groups: 0,
      bytes: 0,
      sharedBytes: 0,
      freesUpTo: 0,
    });
  });
});
