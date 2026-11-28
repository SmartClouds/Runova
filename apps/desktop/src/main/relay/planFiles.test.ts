import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderItemFile, renderPlanFile, renderTaskFile } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendJournal,
  archiveAttempt,
  hasRecords,
  itemIds,
  legPointers,
  readAllItems,
  readJournal,
  readPlan,
  writeItemFile,
  writePlan,
} from './planFiles';
import { redoTasks } from './redo';
import { ensureGuide, type RelayFolder, relayFolder, setTaskStatusFile } from './taskFiles';

let root: string;
let folder: RelayFolder;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relay-plan-'));
  folder = relayFolder(root, 'docs');
  mkdirSync(folder.tasksDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const read = (...parts: string[]) => readFileSync(join(folder.tasksDir, ...parts), 'utf-8');
const write = (path: string, content: string) => {
  const full = join(folder.tasksDir, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
};

describe('PLAN.md', () => {
  it('writes a new plan, and only changes the mode of one a person wrote', async () => {
    expect(await readPlan(folder)).toBeNull();
    expect(await writePlan(folder, null)).toBe('none');
    expect(await writePlan(folder, renderPlanFile({ title: 'Ours', mode: 'fit' }))).toBe('written');
    write('PLAN.md', `${read('PLAN.md')}\nOur own note.\n`);
    expect(await writePlan(folder, renderPlanFile({ title: 'Theirs' }), 'fit')).toBe('kept');
    expect(await writePlan(folder, renderPlanFile({ title: 'Theirs' }), 'plan')).toBe('updated');
    const plan = await readPlan(folder);
    expect(plan).toMatchObject({ title: 'Ours', mode: 'plan', keepRolling: true });
    expect(read('PLAN.md')).toContain('Our own note.');
  });
});

describe('records', () => {
  it('reads every kind, numbers new ones, and refuses a name that is not a record', async () => {
    write(
      'decisions/D002-use-sqlite.md',
      renderItemFile({ kind: 'decision', id: 'D002', title: 'Use SQLite' }),
    );
    write('decisions/notes.md', '# not a record\n');
    expect(await hasRecords(folder)).toBe(true);
    expect((await itemIds(folder)).decision).toEqual(['D002']);
    expect(
      await writeItemFile(
        folder,
        'workaround',
        'W001-pin.md',
        renderItemFile({ kind: 'workaround', id: 'W001', title: 'Pin' }),
      ),
    ).toBe(true);
    expect(await writeItemFile(folder, 'workaround', '../W002-escape.md', 'x')).toBe(false);
    expect(await writeItemFile(folder, 'workaround', 'D001-wrong-kind.md', 'x')).toBe(false);
    const all = await readAllItems(folder);
    expect(all.decision.map((item) => item.id)).toEqual(['D002']);
    expect(all.workaround.map((item) => item.title)).toEqual(['Pin']);
    expect(all.risk).toEqual([]);
  });

  it('says there are no records on a board without decisions or workarounds', async () => {
    write('risks/R001-x.md', renderItemFile({ kind: 'risk', id: 'R001', title: 'X' }));
    expect(await hasRecords(folder)).toBe(false);
  });
});

describe('journal and attempts', () => {
  const entry = {
    at: '2026-11-28T10:00:00.000Z',
    legNo: 1,
    cliId: 'claude-code',
    model: null,
    effort: null,
    result: 'continue' as const,
    tests: 'not-run' as const,
    peakContextTokens: null,
    minutes: 12,
    commit: null,
    attempt: null,
  };

  it('keeps a journal per task and archives an attempt with its handoff', async () => {
    write('T001-login.md', renderTaskFile({ id: 'T001', title: 'Login' }));
    await appendJournal(folder, 'T001', entry);
    await appendJournal(folder, 'T001', { ...entry, legNo: 2, result: 'done' });
    expect(await readJournal(folder, 'T001')).toMatch(/session 1[\s\S]*session 2/);
    write('handoffs/T001.md', '---\ntask: T001\n---\n\n## Purpose\n\nSign in.\n');

    expect(await archiveAttempt(folder, 'T001', 1, 'claude-code')).toBe(true);
    const archive = read('handoffs', 'archive', 'T001-attempt-1.md');
    expect(archive).toContain('Sign in.');
    expect(archive).toContain('session 2');
    expect(existsSync(join(folder.handoffsDir, 'T001.md'))).toBe(false);
    expect(await readJournal(folder, 'T001')).toBeNull();
    // The same attempt is never archived twice, and an id that is not a task is refused.
    expect(await archiveAttempt(folder, 'T001', 1, null)).toBe(false);
    expect(await archiveAttempt(folder, '../T001', 1, null)).toBe(false);
  });

  it('points a session at the plan, the records and the attempt it learns from', async () => {
    expect(await legPointers(folder, { id: 'T001', learnFrom: null })).toEqual({
      hasPlan: false,
      hasRecords: false,
      previousAttempt: null,
    });
    write('PLAN.md', renderPlanFile({ title: 'P' }));
    write(
      'workarounds/W001-pin.md',
      renderItemFile({ kind: 'workaround', id: 'W001', title: 'Pin' }),
    );
    write('handoffs/archive/T001-attempt-1.md', '# old\n');
    expect(await legPointers(folder, { id: 'T001', learnFrom: 1 })).toEqual({
      hasPlan: true,
      hasRecords: true,
      previousAttempt: 'docs/tasks/handoffs/archive/T001-attempt-1.md',
    });
    expect((await legPointers(folder, { id: 'T001', learnFrom: 3 })).previousAttempt).toBeNull();
  });

  it('redoes tasks: archives, raises the attempt, unticks criteria and skips a running one', async () => {
    write(
      'T001-login.md',
      renderTaskFile({ id: 'T001', title: 'Login', status: 'done', acceptance: ['Signs in'] }),
    );
    write('T002-search.md', renderTaskFile({ id: 'T002', title: 'Search', status: 'in-progress' }));
    write('handoffs/T001.md', '---\ntask: T001\noutcome: done\n---\n\n## Purpose\n\nSign in.\n');

    const result = await redoTasks(folder, {
      taskIds: ['T001', 'T002', 'T404'],
      agent: 'gemini-cli',
      keepLearnings: false,
    });
    expect(result.redone).toEqual(['T001']);
    expect(result.warnings).toHaveLength(2);
    const task = read('T001-login.md');
    expect(task).toContain('status: todo');
    expect(task).toContain('attempt: 2');
    expect(task).toContain('agent: gemini-cli');
    expect(task).toContain('- [ ] Signs in');
    expect(task).not.toContain('learnFrom');
    expect(read('handoffs', 'archive', 'T001-attempt-1.md')).toContain('Sign in.');

    const all = await redoTasks(folder, { taskIds: 'all', agent: null, keepLearnings: true });
    // T001 is todo now and T002 is still running, so only T001 goes again.
    expect(all.redone).toEqual(['T001']);
    // Its second attempt left nothing to archive, so it has nothing to learn from.
    expect(read('T001-login.md')).toContain('attempt: 3');
    expect(read('T001-login.md')).not.toContain('learnFrom');
  });
});

describe('task files', () => {
  it('stamps when a task starts and when it is done, once each', async () => {
    write('T001-login.md', renderTaskFile({ id: 'T001', title: 'Login' }));
    await setTaskStatusFile(folder, 'T001', 'in-progress', new Date('2026-11-28T09:00:00.123Z'));
    await setTaskStatusFile(folder, 'T001', 'testing', new Date('2026-11-28T09:30:00Z'));
    await setTaskStatusFile(folder, 'T001', 'in-progress', new Date('2026-11-28T10:00:00Z'));
    await setTaskStatusFile(folder, 'T001', 'done', new Date('2026-11-28T11:00:00Z'));
    const task = read('T001-login.md');
    expect(task).toContain('started: 2026-11-28T09:00:00Z');
    expect(task).toContain('finished: 2026-11-28T11:00:00Z');
    expect(task.match(/started:/g)).toHaveLength(1);
  });

  it('replaces an older guide Runova wrote, and leaves one a person wrote', async () => {
    write('RELAY.md', '# Relay\n\nThis file is the format. Runova wrote it; keep it as it is.\n');
    await ensureGuide(folder);
    expect(read('RELAY.md')).toContain('runova-relay-guide: 2');
    write('RELAY.md', '# Our own rules\n');
    await ensureGuide(folder);
    expect(read('RELAY.md')).toBe('# Our own rules\n');
  });
});
