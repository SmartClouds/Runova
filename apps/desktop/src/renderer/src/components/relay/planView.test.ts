import { parseItemFile, renderItemFile } from '@runova/core';
import { describe, expect, it } from 'vitest';
import {
  acceptanceItems,
  filterTasks,
  isOverdue,
  milestoneRows,
  NO_FILTER,
  progressOf,
  sortTasks,
} from './planView';
import { card } from './testing/fixtures';

const milestone = (id: string, title: string) =>
  parseItemFile('milestone', `${id}-x.md`, renderItemFile({ kind: 'milestone', id, title }));

describe('planView', () => {
  const tasks = [
    card('T001', { status: 'done', milestone: 'M001', priority: 'p2', due: '2026-12-01' }),
    card('T002', { status: 'todo', milestone: 'M001', priority: 'p0', labels: ['api'] }),
    card('T003', { status: 'blocked', milestone: 'M009', size: 'xl' }),
    card('T010', { status: 'testing', title: 'Alpha' }),
  ];

  it('counts progress and groups tasks by milestone, loose ones last', () => {
    expect(progressOf(tasks)).toEqual({ done: 1, total: 4, percent: 25 });
    expect(progressOf([])).toEqual({ done: 0, total: 0, percent: 0 });
    const rows = milestoneRows(tasks, [milestone('M002', 'Beta'), milestone('M001', 'Pilot')]);
    expect(
      rows.map((row) => [row.milestone?.id ?? null, row.tasks.map((task) => task.id)]),
    ).toEqual([
      ['M001', ['T001', 'T002']],
      ['M002', []],
      [null, ['T003', 'T010']],
    ]);
    expect(rows[0].progress.percent).toBe(50);
  });

  it('sorts by any column with empty values last either way', () => {
    expect(sortTasks(tasks, 'priority').map((task) => task.id)).toEqual([
      'T002',
      'T001',
      'T003',
      'T010',
    ]);
    expect(sortTasks(tasks, 'priority', true).map((task) => task.id)).toEqual([
      'T001',
      'T002',
      'T003',
      'T010',
    ]);
    expect(sortTasks(tasks, 'status').map((task) => task.id)).toEqual([
      'T003',
      'T010',
      'T002',
      'T001',
    ]);
    expect(sortTasks(tasks, 'id', true)[0].id).toBe('T010');
  });

  it('filters by text, status, priority, milestone and label', () => {
    expect(filterTasks(tasks, { ...NO_FILTER, text: 'alpha' }).map((task) => task.id)).toEqual([
      'T010',
    ]);
    expect(filterTasks(tasks, { ...NO_FILTER, milestone: 'M001', priority: 'p0' })).toHaveLength(1);
    expect(filterTasks(tasks, { ...NO_FILTER, label: 'api' })[0].id).toBe('T002');
    expect(filterTasks(tasks, { ...NO_FILTER, status: 'done' })[0].id).toBe('T001');
  });

  it('reads the acceptance criteria the way the card counts them', () => {
    const body =
      '## Goal\n\n- [ ] not this\n\n## Acceptance criteria\n\n- [x] Works\n- [ ] Fast\n\n## Test plan\n';
    expect(acceptanceItems(body)).toEqual([
      { text: 'Works', checked: true },
      { text: 'Fast', checked: false },
    ]);
    expect(acceptanceItems('- [ ] one\n* [X] two')).toEqual([
      { text: 'one', checked: false },
      { text: 'two', checked: true },
    ]);
  });

  it('knows an overdue date', () => {
    expect(isOverdue('2026-11-01', '2026-11-28')).toBe(true);
    expect(isOverdue('2026-12-01', '2026-11-28')).toBe(false);
    expect(isOverdue(null, '2026-11-28')).toBe(false);
    expect(isOverdue('soon', '2026-11-28')).toBe(false);
  });
});
