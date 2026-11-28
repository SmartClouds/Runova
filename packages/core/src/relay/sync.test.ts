import { describe, expect, it } from 'vitest';
import { parseItemFile, parsePlanFile, renderItemFile, renderPlanFile } from './plan.js';
import { duplicateIds, planCommitMessage, renderStatusFile } from './sync.js';

const item = (
  kind: 'milestone' | 'workaround' | 'question' | 'risk' | 'decision',
  id: string,
  extra = {},
) => parseItemFile(kind, `${id}-x.md`, renderItemFile({ kind, id, title: `Item ${id}`, ...extra }));

const empty = { milestone: [], decision: [], workaround: [], risk: [], question: [] };

describe('STATUS.md', () => {
  const tasks = [
    { id: 'T001', title: 'Login', status: 'done' as const, milestone: 'M001', priority: null },
    { id: 'T002', title: 'Search', status: 'blocked' as const, milestone: 'M001', priority: null },
    { id: 'T003', title: 'Export', status: 'todo' as const, milestone: null, priority: null },
  ];

  it('sums up the plan, its milestones and what is open, the same way every time', () => {
    const input = {
      plan: parsePlanFile(renderPlanFile({ title: 'Clinic' })),
      tasks,
      items: {
        ...empty,
        milestone: [item('milestone', 'M001', { target: '2026-12-01' })],
        workaround: [item('workaround', 'W001', { dependency: 'zod', waitingFor: '4.7.0' })],
        question: [item('question', 'Q001')],
        decision: [item('decision', 'D001', { status: 'accepted' })],
      },
    };
    const text = renderStatusFile(input);
    expect(text).toContain('# Status: Clinic');
    expect(text).toContain('**1 of 3 tasks done (33%).**');
    expect(text).toContain('| M001 Item M001 | planned | 2026-12-01 | 1 of 2 |');
    expect(text).toContain('- T002 Search (blocked)');
    expect(text).toContain('- W001 Item W001 (waits for zod 4.7.0)');
    expect(text).toContain('- Q001 Item Q001');
    expect(text).toContain('1 decisions are recorded');
    expect(renderStatusFile(input)).toBe(text);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toContain('—');
  });

  it('works without a plan or records', () => {
    expect(renderStatusFile({ plan: null, tasks: [], items: empty })).toContain(
      '**0 of 0 tasks done (0%).**',
    );
  });
});

describe('planCommitMessage', () => {
  it('names what was added, updated and removed', () => {
    expect(
      planCommitMessage([
        { code: '??', path: 'workarounds/W003-pin.md' },
        { code: ' M', path: 'T012-search.md' },
        { code: ' D', path: 'T004-old.md' },
        { code: ' M', path: 'PLAN.md' },
        { code: ' M', path: 'journal/T012.md' },
        { code: ' M', path: 'STATUS.md' },
      ]),
    ).toBe('docs(tasks): update the plan, add W003, update T012, remove T004');
  });

  it('calls journals and handoffs alone a progress update', () => {
    expect(
      planCommitMessage([
        { code: ' M', path: 'handoffs/T001.md' },
        { code: '??', path: 'journal/T001.md' },
      ]),
    ).toBe('docs(tasks): record progress');
  });

  it('keeps a long message short', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      code: ' M',
      path: `T${String(index + 1).padStart(3, '0')}-x.md`,
    }));
    expect(planCommitMessage(many).length).toBeLessThanOrEqual(100);
  });
});

describe('duplicateIds', () => {
  it('finds ids two files share', () => {
    expect(
      duplicateIds([
        'T001-a.md',
        'T002-b.md',
        'T002-c.md',
        'decisions/D001-x.md',
        'decisions/D001-y.md',
      ]),
    ).toEqual([
      { id: 'T002', files: ['T002-b.md', 'T002-c.md'] },
      { id: 'D001', files: ['decisions/D001-x.md', 'decisions/D001-y.md'] },
    ]);
  });
});
