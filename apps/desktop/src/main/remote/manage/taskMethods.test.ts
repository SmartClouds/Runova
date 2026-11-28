import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderItemFile, renderPlanFile, renderTaskFile } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayBoard } from '../../../shared/relayTypes';
import { type RelayFolder, readBoardFiles, relayFolder } from '../../relay/taskFiles';
import { ManageError } from './session';
import { type ManageTaskDeps, taskMethods } from './taskMethods';

let root: string;
let folder: RelayFolder;

async function board(): Promise<RelayBoard> {
  const files = await readBoardFiles(folder);
  return {
    projectId: 'p1',
    docsFolder: 'docs',
    exists: files.exists,
    guidePresent: files.guidePresent,
    tasks: files.files.map(({ task }) => {
      const { body: _body, ...card } = task;
      return { ...card, handoff: null, legCount: 0, legPeaks: [] };
    }),
    order: files.files.map((file) => file.task.id),
    cycles: [],
    missing: [],
    issues: [],
    settings: {} as RelayBoard['settings'],
    active: null,
  };
}

function deps(overrides: Partial<ManageTaskDeps> = {}) {
  const fake = {
    folder: vi.fn(async () => folder),
    board: vi.fn(board),
    detail: vi.fn(async (_projectId: string, taskId: string) => {
      const file = (await readBoardFiles(folder)).files.find((entry) => entry.task.id === taskId);
      return file ? { task: file.task, handoff: null, handoffText: null, legs: [] } : null;
    }),
    setStatus: vi.fn(async () => undefined),
    decompose: vi.fn(),
    cancelPlanner: vi.fn(),
    applyProposal: vi.fn(async () => ({ written: ['T003-x.md'], removed: [], warnings: [] })),
    redo: vi.fn(async () => ({ redone: ['T001'], warnings: [], started: true })),
    start: vi.fn(async () => ({ ok: true as const, run: {} as never })),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    active: vi.fn(() => null),
    changed: vi.fn(),
    ...overrides,
  } satisfies ManageTaskDeps;
  return { fake, calls: taskMethods(fake) };
}

const context = {} as never;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'manage-tasks-'));
  folder = relayFolder(root, 'docs');
  mkdirSync(join(folder.tasksDir, 'questions'), { recursive: true });
  writeFileSync(
    join(folder.tasksDir, 'T001-login.md'),
    renderTaskFile({
      id: 'T001',
      title: 'Login',
      status: 'blocked',
      milestone: 'M001',
      goal: 'Sign in.',
      acceptance: ['Works', 'Fast'],
    }),
  );
  writeFileSync(
    join(folder.tasksDir, 'T002-search.md'),
    renderTaskFile({ id: 'T002', title: 'Search', status: 'done', milestone: 'M001' }),
  );
  writeFileSync(
    join(folder.tasksDir, 'PLAN.md'),
    renderPlanFile({ title: 'Clinic', goal: 'Paperless.' }),
  );
  mkdirSync(join(folder.tasksDir, 'milestones'), { recursive: true });
  writeFileSync(
    join(folder.tasksDir, 'milestones', 'M001-pilot.md'),
    renderItemFile({ kind: 'milestone', id: 'M001', title: 'Pilot' }),
  );
  writeFileSync(
    join(folder.tasksDir, 'questions', 'Q001-ward.md'),
    renderItemFile({ kind: 'question', id: 'Q001', title: 'Which ward?' }),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const read = (name: string) => readFileSync(join(folder.tasksDir, name), 'utf-8');

describe('the tasks methods', () => {
  it('sum up the plan for the overview', async () => {
    const { calls } = deps();
    const overview = (await calls['tasks.overview']({ projectId: 'p1' }, context)) as Record<
      string,
      unknown
    >;
    expect(overview).toMatchObject({
      exists: true,
      plan: { title: 'Clinic', mode: 'fit', goal: 'Paperless.' },
      done: 1,
      total: 2,
      counts: { blocked: 1, done: 1 },
      milestones: [{ id: 'M001', title: 'Pilot', done: 1, total: 2 }],
      needsYou: [{ id: 'T001', statusLabel: 'Blocked' }],
      questions: [{ id: 'Q001', title: 'Which ward?' }],
      run: null,
    });
  });

  it('list the tasks and open one with its sections, criteria and journal', async () => {
    const { calls } = deps();
    const rows = (await calls['tasks.board']({ projectId: 'p1' }, context)) as { id: string }[];
    expect(rows.map((one) => one.id)).toEqual(['T001', 'T002']);
    const detail = (await calls['tasks.detail']({ projectId: 'p1', taskId: 'T001' }, context)) as {
      sections: { heading: string; text: string }[];
      acceptance: { text: string; checked: boolean }[];
      journal: unknown[];
    };
    expect(detail.sections).toEqual([{ heading: 'Goal', text: 'Sign in.' }]);
    expect(detail.acceptance).toEqual([
      { text: 'Works', checked: false },
      { text: 'Fast', checked: false },
    ]);
    expect(detail.journal).toEqual([]);
  });

  it('edit tasks in place and say so, telling the computer each time', async () => {
    const { calls, fake } = deps();
    await calls['tasks.update'](
      { projectId: 'p1', taskId: 'T001', patch: { priority: 'p1', due: '2026-12-01' } },
      context,
    );
    await calls['tasks.toggleAcceptance'](
      { projectId: 'p1', taskId: 'T001', index: 1, checked: true },
      context,
    );
    const created = (await calls['tasks.create'](
      { projectId: 'p1', title: 'Export' },
      context,
    )) as {
      ok: boolean;
      id: string;
    };
    expect(created).toMatchObject({ ok: true, id: 'T003' });
    expect(read('T001-login.md')).toContain('priority: p1');
    expect(read('T001-login.md')).toContain('- [x] Fast');
    expect(fake.changed).toHaveBeenCalledTimes(3);

    await calls['tasks.setStatus']({ projectId: 'p1', taskId: 'T001', status: 'todo' }, context);
    expect(fake.setStatus).toHaveBeenCalledWith('p1', 'T001', 'todo');
  });

  it('read and write records, refusing sections and statuses a kind has not got', async () => {
    const { calls } = deps();
    await calls['tasks.saveItem'](
      {
        projectId: 'p1',
        item: { kind: 'question', id: 'Q001', status: 'answered', sections: { Answer: 'Ward A.' } },
      },
      context,
    );
    const items = (await calls['tasks.items']({ projectId: 'p1', kind: 'question' }, context)) as {
      status: string;
      sections: { heading: string; text: string }[];
    }[];
    expect(items[0]).toMatchObject({
      status: 'answered',
      sections: [{ heading: 'Answer', text: 'Ward A.' }],
    });
    await expect(
      Promise.resolve().then(() =>
        calls['tasks.saveItem'](
          { projectId: 'p1', item: { kind: 'question', id: 'Q001', status: 'gone' } },
          context,
        ),
      ),
    ).rejects.toBeInstanceOf(ManageError);
    await expect(
      Promise.resolve().then(() =>
        calls['tasks.saveItem'](
          { projectId: 'p1', item: { kind: 'question', id: 'Q001', sections: { Secret: 'x' } } },
          context,
        ),
      ),
    ).rejects.toThrow(/not a section/);
  });

  it('refuse ids and inputs that are not what they say', async () => {
    const { calls } = deps();
    const hostile = [
      ['tasks.detail', { projectId: 'p1', taskId: '../T001' }],
      ['tasks.update', { projectId: 'p1', taskId: 'T001', patch: { due: 'tomorrow' } }],
      ['tasks.update', { projectId: 'p1', taskId: 'T001', patch: { priority: 'urgent' } }],
      ['tasks.setStatus', { projectId: 'p1', taskId: 'T001', status: 'shipped' }],
      ['tasks.toggleAcceptance', { projectId: 'p1', taskId: 'T001', index: -1, checked: true }],
      ['tasks.items', { projectId: 'p1', kind: 'secrets' }],
      ['tasks.saveItem', { projectId: 'p1', item: { kind: 'decision', id: '../D001' } }],
      ['tasks.redo', { projectId: 'p1', taskIds: ['T001; rm -rf'] }],
      ['tasks.applyProposal', { projectId: 'p1', proposal: 'DROP TABLE' }],
      ['tasks.board', { projectId: '' }],
    ] as const;
    for (const [method, params] of hostile) {
      await expect(
        Promise.resolve().then(() => calls[method](params, context)),
        method,
      ).rejects.toBeInstanceOf(ManageError);
    }
  });

  it('split work with the planner, add the plan, redo and run it', async () => {
    const proposal = {
      summary: 'Two parts.',
      plan: { title: 'P' },
      milestones: [{ title: 'M' }],
      add: [{ title: 'A' }, { title: 'B' }],
      change: [],
      split: [],
      remove: [],
    };
    const { calls, fake } = deps({
      decompose: vi.fn(async () => ({
        ok: true as const,
        proposal,
        entries: [
          { kind: 'add' as const, id: 'T003', title: 'A', fields: [] },
          { kind: 'add' as const, id: 'T004', title: 'B', fields: [] },
        ],
        cliName: 'Claude Code',
      })),
      active: vi.fn(() => ({ id: 'r1' }) as never),
    });
    const split = (await calls['tasks.split'](
      { projectId: 'p1', request: 'Search', requestId: 'phone-1', mode: 'plan' },
      context,
    )) as Record<string, unknown>;
    expect(fake.decompose).toHaveBeenCalledWith({
      requestId: 'phone-1',
      projectId: 'p1',
      request: 'Search',
      mode: 'plan',
    });
    expect(split).toMatchObject({
      ok: true,
      entries: [
        { id: 'T003', title: 'A' },
        { id: 'T004', title: 'B' },
      ],
      extras: 'Also writes the plan, 1 milestone.',
    });
    await calls['tasks.applyProposal']({ projectId: 'p1', proposal, mode: 'plan' }, context);
    expect(fake.applyProposal).toHaveBeenCalledWith('p1', proposal, 'plan');
    await calls['tasks.cancelSplit']({ requestId: 'phone-1' }, context);
    expect(fake.cancelPlanner).toHaveBeenCalledWith('phone-1');

    const redo = (await calls['tasks.redo'](
      { projectId: 'p1', taskIds: ['T001'], agent: 'codex-cli', keepLearnings: true, start: true },
      context,
    )) as { ok: boolean; message: string };
    expect(redo).toEqual({ ok: true, message: 'T001 started again.' });
    expect(fake.redo).toHaveBeenCalledWith({
      projectId: 'p1',
      taskIds: ['T001'],
      agent: 'codex-cli',
      keepLearnings: true,
      start: true,
    });
    await calls['tasks.start']({ projectId: 'p1' }, context);
    await calls['tasks.pause']({ projectId: 'p1' }, context);
    await calls['tasks.resume']({ projectId: 'p1' }, context);
    expect(fake.pause).toHaveBeenCalledWith('r1');
    expect(fake.resume).toHaveBeenCalledWith('r1');
  });
});
