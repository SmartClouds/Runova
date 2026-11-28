import { describe, expect, it } from 'vitest';
import { parseHandoff, parseTaskFile, renderTaskFile } from './parse.js';
import { applyProposal, diffProposal, parsePlanProposal, withBudget } from './proposal.js';
import type { RelayTask } from './types.js';

function existing(
  id: string,
  title: string,
  options: Partial<Pick<RelayTask, 'status' | 'depends' | 'estimate' | 'epic'>> = {},
) {
  const content = renderTaskFile({
    id,
    title,
    status: options.status ?? 'todo',
    depends: options.depends,
    estimate: options.estimate ?? null,
    epic: options.epic ?? null,
    goal: `Goal of ${title}.`,
    acceptance: [`${title} works`],
  });
  const file = `${id}-${title.toLowerCase().replace(/\s+/g, '-')}.md`;
  return { file, content, task: parseTaskFile(file, content) };
}

describe('parsePlanProposal', () => {
  it('reads JSON wrapped in a fence and prose', () => {
    const text = [
      'Here is the plan:',
      '```json',
      JSON.stringify({
        summary: 'Two tasks.',
        add: [
          { id: 'T005', title: 'Schema', estimate: '80k', acceptance: ['Migrates'] },
          { id: 'T006', title: 'Endpoint', depends: ['T005'], estimate: 60000 },
        ],
      }),
      '```',
    ].join('\n');
    const result = parsePlanProposal(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.summary).toBe('Two tasks.');
    expect(result.proposal.add.map((task) => [task.id, task.estimate])).toEqual([
      ['T005', 80_000],
      ['T006', 60_000],
    ]);
    expect(result.proposal.change).toEqual([]);
  });

  it('explains what is wrong with an answer that is not a proposal', () => {
    expect(parsePlanProposal('I could not do it.')).toEqual({
      ok: false,
      error: expect.stringContaining('JSON'),
    });
    expect(parsePlanProposal('{"add": [{"title": 5}]}')).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });
});

describe('applyProposal', () => {
  const board = [
    existing('T001', 'Login', { status: 'done' }),
    existing('T002', 'Search', { depends: ['T001'], estimate: 250_000 }),
    existing('T003', 'Export', { depends: ['T002'] }),
  ];

  it('writes added tasks under fresh ids and keeps their dependencies pointing right', () => {
    const plan = applyProposal(board, {
      summary: '',
      add: [
        { id: 'T002', title: 'Clashing id', depends: ['T001'] },
        { id: 'T009', title: 'After it', depends: ['T002'] },
      ],
      change: [],
      split: [],
      remove: [],
    });
    const written = plan.write.map((file) => parseTaskFile(file.file, file.content));
    expect(written.map((task) => [task.id, task.title, task.depends])).toEqual([
      ['T004', 'Clashing id', ['T001']],
      ['T005', 'After it', ['T004']],
    ]);
    expect(plan.remove).toEqual([]);
  });

  it('writes the budget a proposal was planned for into its new tasks', () => {
    const proposal = withBudget(
      {
        summary: '',
        add: [{ title: 'Planned' }, { title: 'Own budget', budget: 400_000 }],
        change: [{ id: 'T003', title: 'Renamed' }],
        split: [{ id: 'T002', into: [{ title: 'Part one' }] }],
        remove: [],
      },
      100_000,
    );
    const written = applyProposal(board, proposal).write.map((file) =>
      parseTaskFile(file.file, file.content),
    );
    expect(Object.fromEntries(written.map((task) => [task.title, task.budget]))).toMatchObject({
      Planned: 100_000,
      'Own budget': 400_000,
      'Part one': 100_000,
    });
    expect(proposal.change).toEqual([{ id: 'T003', title: 'Renamed' }]);
  });

  it('changes a task but never a done one', () => {
    const plan = applyProposal(board, {
      summary: '',
      add: [],
      change: [
        { id: 'T003', title: 'Export to CSV', acceptance: ['Writes a CSV', 'Escapes commas'] },
        { id: 'T001', title: 'Login again' },
      ],
      split: [],
      remove: [],
    });
    expect(plan.write).toHaveLength(1);
    const task = parseTaskFile(plan.write[0].file, plan.write[0].content);
    expect(task).toMatchObject({
      id: 'T003',
      title: 'Export to CSV',
      depends: ['T002'],
      acceptance: { total: 2 },
    });
    expect(plan.write[0].content).toContain('Goal of Export.');
    expect(plan.warnings).toEqual([expect.stringContaining('T001')]);
  });

  it('splits an oversized task and moves its dependents onto the new parts', () => {
    const plan = applyProposal(board, {
      summary: '',
      add: [],
      change: [],
      split: [
        {
          id: 'T002',
          into: [
            { id: 'T010', title: 'Search API', estimate: 90_000 },
            { id: 'T011', title: 'Search UI', depends: ['T010'], estimate: 90_000 },
          ],
        },
      ],
      remove: [],
    });
    expect(plan.remove).toEqual(['T002-search.md']);
    const written = new Map(
      plan.write.map((file) => {
        const task = parseTaskFile(file.file, file.content);
        return [task.id, task];
      }),
    );
    expect(written.get('T004')).toMatchObject({ title: 'Search API', depends: ['T001'] });
    expect(written.get('T005')).toMatchObject({ title: 'Search UI', depends: ['T004'] });
    expect(written.get('T003')?.depends).toEqual(['T004', 'T005']);
  });

  it('removes a task and drops it from what depended on it', () => {
    const plan = applyProposal(board, {
      summary: '',
      add: [],
      change: [],
      split: [],
      remove: [{ id: 'T002', reason: 'Not needed.' }],
    });
    expect(plan.remove).toEqual(['T002-search.md']);
    expect(parseTaskFile(plan.write[0].file, plan.write[0].content).depends).toEqual([]);
  });

  it('adds no handoffs when the proposal has none', () => {
    const plan = applyProposal(board, {
      summary: '',
      add: [{ title: 'New' }],
      change: [],
      split: [],
      remove: [],
    });
    expect(plan.handoffs).toEqual([]);
  });
});

describe('catching up with work already done', () => {
  const empty: ReturnType<typeof existing>[] = [];

  it('records finished work as done tasks with ticked criteria and a done handoff', () => {
    const plan = applyProposal(empty, {
      summary: '',
      add: [
        {
          title: 'Login',
          status: 'done',
          goal: 'Users can sign in.',
          acceptance: ['Signs in with a password'],
          handoff: { done: 'src/auth/login.ts, covered by login.test.ts.' },
        },
        { title: 'Search', depends: ['T001'] },
      ],
      change: [],
      split: [],
      remove: [],
    });
    const [login, search] = plan.write.map((file) => parseTaskFile(file.file, file.content));
    expect(login).toMatchObject({
      id: 'T001',
      status: 'done',
      acceptance: { checked: 1, total: 1 },
    });
    expect(search).toMatchObject({ id: 'T002', status: 'todo', depends: ['T001'] });
    expect(plan.handoffs).toHaveLength(1);
    const handoff = parseHandoff('T001', plan.handoffs[0].content);
    expect(plan.handoffs[0].taskId).toBe('T001');
    expect(handoff.outcome).toBe('done');
    expect(handoff.sections.purpose).toBe('Users can sign in.');
    expect(handoff.sections.done).toBe('src/auth/login.ts, covered by login.test.ts.');
  });

  it('starts half-done work from a handoff that says where it stands', () => {
    const plan = applyProposal(empty, {
      summary: '',
      add: [
        {
          title: 'Export',
          handoff: { done: 'CSV export works.', next: 'Add the PDF export.' },
        },
      ],
      change: [],
      split: [],
      remove: [],
    });
    expect(parseTaskFile(plan.write[0].file, plan.write[0].content).status).toBe('todo');
    const handoff = parseHandoff('T001', plan.handoffs[0].content);
    expect(handoff).toMatchObject({ outcome: 'continue', tests: 'not-run', leg: 0 });
    expect(handoff.sections.purpose).toBe('Export');
    expect(handoff.sections.next).toBe('Add the PDF export.');
  });

  it('marks a board task done when the code shows it is, with its handoff', () => {
    const plan = applyProposal(board(), {
      summary: '',
      add: [],
      change: [{ id: 'T002', status: 'done', handoff: { done: 'Search is built.' } }],
      split: [],
      remove: [],
    });
    expect(parseTaskFile(plan.write[0].file, plan.write[0].content).status).toBe('done');
    expect(plan.handoffs.map((entry) => entry.taskId)).toEqual(['T002']);
    expect(parseHandoff('T002', plan.handoffs[0].content).sections.purpose).toBe('Goal of Search.');
  });

  it('reads any status other than done as todo', () => {
    const result = parsePlanProposal(
      JSON.stringify({
        add: [
          { title: 'A', status: 'Done' },
          { title: 'B', status: 'in-progress' },
          { title: 'C' },
        ],
      }),
    );
    expect(result.ok && result.proposal.add.map((task) => task.status)).toEqual([
      'done',
      'todo',
      undefined,
    ]);
  });

  it('shows the new status and the handoff in the review', () => {
    const entries = diffProposal(board(), {
      summary: '',
      add: [{ title: 'Login', status: 'done', handoff: { done: 'Built.' } }],
      change: [{ id: 'T002', status: 'done', handoff: { done: 'Built.' } }],
      split: [],
      remove: [],
    });
    expect(entries).toEqual([
      { kind: 'add', id: 'T004', title: 'Login', fields: [], status: 'done', handoff: true },
      {
        kind: 'change',
        id: 'T002',
        title: 'Search',
        fields: [{ field: 'status', before: 'todo', after: 'done' }],
        handoff: true,
      },
    ]);
  });

  function board() {
    return [
      existing('T001', 'Login', { status: 'done' }),
      existing('T002', 'Search', { depends: ['T001'] }),
      existing('T003', 'Export', { depends: ['T002'] }),
    ];
  }
});

describe('diffProposal', () => {
  it('lists what the proposal would do, field by field', () => {
    const board = [existing('T002', 'Search', { estimate: 250_000 })];
    const entries = diffProposal(board, {
      summary: '',
      add: [{ id: 'T003', title: 'New' }],
      change: [{ id: 'T002', title: 'Search patients', estimate: 120_000 }],
      split: [],
      remove: [],
    });
    expect(entries).toEqual([
      { kind: 'add', id: 'T003', title: 'New', fields: [] },
      {
        kind: 'change',
        id: 'T002',
        title: 'Search patients',
        fields: [
          { field: 'title', before: 'Search', after: 'Search patients' },
          { field: 'estimate', before: '250K', after: '120K' },
        ],
      },
    ]);
  });
});

describe('a plan-mode proposal', () => {
  const board = [existing('T001', 'Login', { status: 'done' })];
  const answer = JSON.stringify({
    summary: 'Two parts in one milestone.',
    plan: { title: 'Paperless clinic', goal: 'No paper charts.', definitionOfDone: ['CI green'] },
    milestones: [{ id: 'M001', title: 'Pilot', goal: 'One ward.', exitCriteria: ['Ward A live'] }],
    risks: [
      { title: 'Staff pushback', likelihood: 'High', impact: 'medium', mitigation: 'Training.' },
    ],
    questions: [{ title: 'Which ward first?', question: 'A or B?' }],
    add: [
      {
        id: 'T002',
        title: 'Chart import',
        milestone: 'M001',
        priority: 'P1',
        size: 'Large',
        context: 'Charts are scanned PDFs.',
        approach: 'OCR then review.',
        acceptance: ['Imports a scanned chart'],
      },
      { id: 'T003', title: 'Ward view', milestone: 'M009', priority: 'whenever' },
    ],
  });

  it('reads the plan, milestones, risks and questions, and drops odd choices', () => {
    const parsed = parsePlanProposal(answer);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.proposal.plan?.title).toBe('Paperless clinic');
    expect(parsed.proposal.risks?.[0]).toMatchObject({ likelihood: 'high', impact: 'medium' });
    expect(parsed.proposal.add[0]).toMatchObject({ priority: 'p1', size: 'l' });
    expect(parsed.proposal.add[1].priority).toBeUndefined();
  });

  it('writes the records with free ids, links tasks to milestones and writes the plan', () => {
    const parsed = parsePlanProposal(answer);
    if (!parsed.ok) throw new Error(parsed.error);
    const plan = applyProposal(board, parsed.proposal, {
      mode: 'plan',
      today: '2026-11-28',
      itemIds: { milestone: ['M001', 'M002'], risk: ['R004'] },
    });
    expect(plan.items.map((item) => [item.kind, item.file])).toEqual([
      ['milestone', 'M003-pilot.md'],
      ['risk', 'R005-staff-pushback.md'],
      ['question', 'Q001-which-ward-first.md'],
    ]);
    const tasks = plan.write.map((file) => parseTaskFile(file.file, file.content));
    expect(tasks[0]).toMatchObject({ id: 'T002', milestone: 'M003', priority: 'p1', size: 'l' });
    expect(tasks[0].body).toContain('## Context');
    expect(tasks[1].milestone).toBeNull();
    expect(plan.warnings).toEqual([
      'T003 named milestone M009, which does not exist; that was dropped.',
    ]);
    expect(plan.items[0].content).toContain('created: 2026-11-28');
    expect(plan.items[0].content).toContain('- [ ] Ward A live');
    expect(plan.plan).toContain('mode: plan');
    expect(plan.plan).toContain('keepRolling: true');
    expect(plan.plan).toContain('# Paperless clinic');
  });

  it('writes no plan and no records for an ordinary proposal', () => {
    const plan = applyProposal(board, {
      summary: '',
      add: [{ title: 'Search' }],
      change: [],
      split: [],
      remove: [],
    });
    expect(plan.items).toEqual([]);
    expect(plan.plan).toBeNull();
  });
});
