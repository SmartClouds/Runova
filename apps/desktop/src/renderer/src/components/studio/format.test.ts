import { describe, expect, it } from 'vitest';
import { groupByDay } from './format';

describe('groupByDay', () => {
  // Noon, so an hour either way stays on the same day whatever the time zone.
  const now = new Date(2026, 10, 5, 12).getTime();
  const at = (day: number, hour = 12, year = 2026, month = 10) =>
    new Date(year, month, day, hour).getTime();

  it('puts a newest-first list into days, keeping its order', () => {
    const items = [
      { id: 'a', at: at(5, 11) },
      { id: 'b', at: at(5, 1) },
      { id: 'c', at: at(4, 23) },
      { id: 'd', at: at(1) },
      { id: 'e', at: at(20, 12, 2025, 2) },
    ];
    const groups = groupByDay(items, (item) => item.at, now);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      ['Nov 1', ['d']],
      ['Mar 20, 2025', ['e']],
    ]);
    expect(groups[0]?.key).toBe('2026-11-05');
  });

  it('gives no groups for no items', () => {
    expect(groupByDay([], () => 0, now)).toEqual([]);
  });

  it('knows yesterday across the start of a month', () => {
    const first = new Date(2026, 11, 1, 9).getTime();
    const groups = groupByDay([at(30, 20)], (t) => t, first);
    expect(groups[0]?.label).toBe('Yesterday');
  });
});
