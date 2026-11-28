import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderTaskFile } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type {
  RelayBoard,
  RelayPlannerResult,
  RelaySingleRun,
  RelayTaskDetail,
} from '../../shared/relayTypes';
import { electronState } from '../../test/main/electronMock';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';
import type { HeadlessPromptResult } from '../cli/headlessPrompt';
import type { RelayRuntime } from '../relay/runtime';

/** The Relay channels: ids in, files read and written by main, run operations to the runtime. */

const cli = vi.hoisted(() => ({
  run: vi.fn<(...args: unknown[]) => Promise<HeadlessPromptResult>>(),
  cancel: vi.fn(() => true),
}));
const watcher = vi.hoisted(() => ({ watch: vi.fn(), unwatch: vi.fn() }));

vi.mock('../cli/headlessPrompt', () => ({
  runHeadlessCliPrompt: cli.run,
  cancelHeadlessPrompt: cli.cancel,
}));
vi.mock('../relay/wiring', () => ({ relayWatcher: () => watcher }));

const userData = useTempUserData();
// The on* channels go main to renderer; the driver tests cover what is sent on them.
expectChannelsCovered(
  IPC.relay,
  Object.entries(IPC.relay)
    .filter(([key]) => key.startsWith('on'))
    .map(([, channel]) => channel),
);

let folder: string;

function runtime(): RelayRuntime {
  return {
    start: vi.fn(async () => ({ ok: false as const, error: 'stub' })),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    markDone: vi.fn(async () => undefined),
    runs: vi.fn(() => []),
    active: vi.fn(() => null),
    reconcile: vi.fn(async () => undefined),
    pendingProposals: vi.fn(() => []),
    decideProposal: vi.fn(async () => null),
  };
}

async function load(live: RelayRuntime | null = runtime()) {
  const module = await loadIpc(
    () => import('./relay'),
    (mod) => mod.registerRelayHandlers(),
  );
  const { setRelayRuntime } = await import('../relay/runtime');
  setRelayRuntime(live);
  return { module, live };
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'relay-ipc-'));
  mkdirSync(join(folder, 'docs', 'tasks'), { recursive: true });
  writeFileSync(
    join(folder, 'docs', 'tasks', 'T001-login.md'),
    renderTaskFile({ id: 'T001', title: 'Login', status: 'todo', goal: 'Sign in.' }),
  );
  writeFileSync(
    join(folder, 'docs', 'tasks', 'T002-search.md'),
    renderTaskFile({ id: 'T002', title: 'Search', status: 'todo', depends: ['T001'] }),
  );
  userData.writeData('projects.json', [
    {
      id: 'p1',
      name: 'Clinic',
      folderPath: folder,
      cliId: 'claude-code',
      description: '',
      tags: [],
      agentType: 'claude-code',
      notes: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
  cli.run.mockReset();
});

afterEach(() => rmSync(folder, { recursive: true, force: true }));

const taskText = (file: string) => readFileSync(join(folder, 'docs', 'tasks', file), 'utf-8');

describe('the board', () => {
  it('lists the tasks in run order with the settings filled in', async () => {
    await load();
    const board = await invoke<RelayBoard>(IPC.relay.board, 'p1');
    expect(board).toMatchObject({
      projectId: 'p1',
      docsFolder: 'docs',
      exists: true,
      guidePresent: false,
      order: ['T001', 'T002'],
      settings: { docsFolder: 'docs', defaults: { cliId: 'claude-code' } },
      active: null,
    });
    expect(board.tasks.map((task) => [task.id, task.handoff, task.legCount])).toEqual([
      ['T001', null, 0],
      ['T002', null, 0],
    ]);
    expect(board.tasks[0]).not.toHaveProperty('body');
  });

  it('adds up the context each session on a task used, skipping sessions with no reading', async () => {
    await load();
    const { addLegRecord } = await import('../relay/store');
    const record = (legId: string, legNo: number, peakContextTokens: number | null) =>
      addLegRecord('p1', {
        legId,
        relayId: 'r1',
        taskId: 'T001',
        legNo,
        cliId: 'claude-code',
        model: null,
        effort: null,
        tabId: null,
        startedAt: 1,
        endedAt: 2,
        outcome: null,
        tests: null,
        result: 'continue',
        peakContextTokens,
      });
    await record('l1', 1, 120_000);
    await record('l2', 2, null);
    await record('l3', 3, 45_000);
    const board = await invoke<RelayBoard>(IPC.relay.board, 'p1');
    expect(board.tasks.map((task) => [task.id, task.legCount, task.legPeaks])).toEqual([
      ['T001', 3, [120_000, 45_000]],
      ['T002', 0, []],
    ]);
  });

  it('gives one task with its body, and null for one that is not there', async () => {
    await load();
    const detail = await invoke<RelayTaskDetail>(IPC.relay.task, 'p1', 'T001');
    expect(detail.task.body).toContain('Sign in.');
    expect(detail.handoff).toBeNull();
    expect(await invoke(IPC.relay.task, 'p1', 'T404')).toBeNull();
  });

  it('refuses ids that are not ids', async () => {
    await load();
    await expect(invoke(IPC.relay.task, 'p1', '../x')).rejects.toThrow();
    await expect(invoke(IPC.relay.board, 42)).rejects.toThrow();
  });

  it('moves and orders tasks in their files', async () => {
    await load();
    await invoke(IPC.relay.setStatus, 'p1', 'T002', 'testing');
    expect(taskText('T002-search.md')).toContain('status: testing');
    await expect(invoke(IPC.relay.setStatus, 'p1', 'T002', 'finished')).rejects.toThrow();
    await expect(invoke(IPC.relay.setStatus, 'p1', 'T404', 'done')).rejects.toThrow(/board/);
    await invoke(IPC.relay.reorder, 'p1', ['T002', 'T001']);
    expect(taskText('T002-search.md')).toContain('order: 1');
    expect(taskText('T001-login.md')).toContain('order: 2');
  });

  it('writes the guide and keeps the board live while watched', async () => {
    await load();
    await invoke(IPC.relay.ensureGuide, 'p1');
    expect(taskText('RELAY.md')).toContain('# Relay');
    await invoke(IPC.relay.watch, 'p1');
    await invoke(IPC.relay.unwatch, 'p1');
    expect(watcher.watch).toHaveBeenCalledWith('p1');
    expect(watcher.unwatch).toHaveBeenCalledWith('p1');
  });

  it('saves settings', async () => {
    await load();
    const saved = await invoke<{ options: { planFirst: boolean } }>(IPC.relay.saveSettings, 'p1', {
      options: { planFirst: true },
    });
    expect(saved.options.planFirst).toBe(true);
    await expect(
      invoke(IPC.relay.saveSettings, 'p1', { options: { guardShare: 5 } }),
    ).rejects.toThrow();
  });
});

describe('running by hand', () => {
  it('prepares a single run: guide, handoff template, status and a prompt', async () => {
    await load();
    const run = await invoke<RelaySingleRun>(IPC.relay.prepareRun, 'p1', 'T002');
    expect(run).toMatchObject({
      legNo: 1,
      planFirst: false,
      choice: { cliId: 'claude-code', autoSize: false },
    });
    expect(run.prompt).toContain('docs/tasks/handoffs/T001.md');
    expect(taskText('T002-search.md')).toContain('status: in-progress');
    expect(taskText(join('handoffs', 'T002.md'))).toContain('task: T002');
    expect(taskText('RELAY.md')).toContain('# Relay');
  });
});

describe('the plan around the tasks', () => {
  it('reads the plan pack and journal, and edits a task in place', async () => {
    await load();
    const empty = await invoke<{ plan: unknown; items: Record<string, unknown[]> }>(
      IPC.relay.planPack,
      'p1',
    );
    expect(empty.plan).toBeNull();
    expect(empty.items.decision).toEqual([]);

    await invoke(IPC.relay.updateTask, 'p1', 'T001', {
      title: 'Sign in',
      priority: 'p1',
      size: 'm',
      labels: ['auth', 'auth'],
      due: '2026-12-01',
      depends: ['T001', 'T002'],
    });
    const task = taskText('T001-login.md');
    expect(task).toContain('title: Sign in');
    expect(task).toContain('priority: p1');
    expect(task).toContain('labels: [auth]');
    expect(task).toContain('depends: [T002]');
    expect(task).toContain('## Goal');

    await invoke(
      IPC.relay.saveTaskBody,
      'p1',
      'T001',
      '## Goal\n\nSign in.\n\n## Acceptance criteria\n\n- [ ] Works\n- [ ] Fast',
    );
    await invoke(IPC.relay.toggleAcceptance, 'p1', 'T001', 1, true);
    expect(taskText('T001-login.md')).toContain('- [ ] Works\n- [x] Fast');
    expect(taskText('T001-login.md')).toContain('priority: p1');
    await expect(invoke(IPC.relay.toggleAcceptance, 'p1', 'T001', 9, true)).rejects.toThrow(
      /criterion 10/,
    );
    expect(await invoke(IPC.relay.journal, 'p1', 'T001')).toEqual([]);
    // Hostile input never reaches the files.
    await expect(invoke(IPC.relay.updateTask, 'p1', '../T001', { title: 'x' })).rejects.toThrow();
    await expect(
      invoke(IPC.relay.updateTask, 'p1', 'T001', { priority: 'urgent' }),
    ).rejects.toThrow();
    await expect(invoke(IPC.relay.updateTask, 'p1', 'T001', { status: 'done' })).rejects.toThrow();
  });

  it('finds an id two files share and gives one of them the next free id', async () => {
    await load();
    writeFileSync(
      join(folder, 'docs', 'tasks', 'T002-from-the-other-laptop.md'),
      renderTaskFile({ id: 'T002', title: 'From the other laptop' }),
    );
    const pack = await invoke<{ duplicates: { id: string; files: string[] }[] }>(
      IPC.relay.planPack,
      'p1',
    );
    expect(pack.duplicates).toEqual([
      { id: 'T002', files: ['T002-from-the-other-laptop.md', 'T002-search.md'] },
    ]);
    const renumbered = await invoke<string>(IPC.relay.renumber, 'p1', 'T002-search.md');
    expect(renumbered).toBe('T003');
    expect(taskText('T003-search.md')).toContain('id: T003');
    expect(existsSync(join(folder, 'docs', 'tasks', 'T002-search.md'))).toBe(false);
    await expect(invoke(IPC.relay.renumber, 'p1', 'T001-login.md')).rejects.toThrow(
      /does not share/,
    );
    for (const hostile of ['../T001-login.md', 'decisions/../../x.md', 'C:\\T001.md', 'T001']) {
      await expect(invoke(IPC.relay.renumber, 'p1', hostile)).rejects.toThrow();
    }
  });

  it('adds and removes tasks, and refuses to remove one others depend on', async () => {
    await load();
    const id = await invoke<string>(IPC.relay.createTask, 'p1', {
      title: 'Export',
      priority: 'p2',
      acceptance: ['Exports CSV'],
    });
    expect(id).toBe('T003');
    expect(taskText('T003-export.md')).toContain('- [ ] Exports CSV');
    await expect(invoke(IPC.relay.removeTask, 'p1', 'T001')).rejects.toThrow(/T002 depend/);
    await invoke(IPC.relay.removeTask, 'p1', 'T003');
    expect(existsSync(join(folder, 'docs', 'tasks', 'T003-export.md'))).toBe(false);
  });

  it('writes the plan and its records, and makes a task from a workaround', async () => {
    await load();
    await invoke(IPC.relay.savePlan, 'p1', { title: 'Clinic', mode: 'plan', goal: 'Paperless.' });
    await invoke(IPC.relay.savePlan, 'p1', { reviewEachTask: true });
    const plan = taskText('PLAN.md');
    expect(plan).toContain('mode: plan');
    expect(plan).toContain('reviewEachTask: true');
    expect(plan).toContain('Paperless.');

    const workaround = await invoke<string>(IPC.relay.saveItem, 'p1', {
      kind: 'workaround',
      title: 'Pin zod',
      fields: { dependency: 'zod', ecosystem: 'npm', waitingFor: '4.7.0', task: 'T001' },
      sections: { 'Proper fix': 'Unpin it.' },
    });
    expect(workaround).toBe('W001');
    await invoke(IPC.relay.saveItem, 'p1', { kind: 'workaround', id: 'W001', status: 'fixed' });
    const pack = await invoke<{ items: { workaround: { status: string; dependency: string }[] } }>(
      IPC.relay.planPack,
      'p1',
    );
    expect(pack.items.workaround[0]).toMatchObject({ status: 'fixed', dependency: 'zod' });
    await expect(
      invoke(IPC.relay.saveItem, 'p1', { kind: 'workaround', id: 'W001', status: 'gone' }),
    ).rejects.toThrow(/status/);
    expect(await invoke(IPC.relay.revisits, 'p1')).toEqual([]);

    await invoke(IPC.relay.saveItem, 'p1', { kind: 'workaround', id: 'W001', status: 'open' });
    const fix = await invoke<string>(IPC.relay.fixWorkaround, 'p1', 'W001');
    expect(taskText(`${fix}-remove-workaround-w001-pin-zod.md`)).toContain('labels: [workaround]');

    await invoke(IPC.relay.removeItem, 'p1', 'workaround', 'W001');
    expect(existsSync(join(folder, 'docs', 'tasks', 'workarounds', 'W001-pin-zod.md'))).toBe(false);
    await expect(invoke(IPC.relay.removeItem, 'p1', 'workaround', '../W001')).rejects.toThrow();
    await expect(
      invoke(IPC.relay.saveItem, 'p1', { kind: 'secret', title: 'x' }),
    ).rejects.toThrow();
  });
});

describe('relays', () => {
  it('hands run operations to the runtime, checked first', async () => {
    const { live } = await load();
    await invoke(IPC.relay.start, { projectId: 'p1', trigger: { kind: 'now' } });
    expect(live?.start).toHaveBeenCalledWith({ projectId: 'p1', trigger: { kind: 'now' } });
    await expect(
      invoke(IPC.relay.start, { projectId: 'p1', trigger: { kind: 'soon' } }),
    ).rejects.toThrow();
    await invoke(IPC.relay.pause, 'r1');
    await invoke(IPC.relay.resume, 'r1');
    await invoke(IPC.relay.cancel, 'r1');
    await invoke(IPC.relay.markDone, 'r1', 'T001');
    expect(await invoke(IPC.relay.runs, 'p1')).toEqual([]);
    await invoke(IPC.relay.reconcile, [{ legId: 'l1', tabId: 't1' }]);
    expect(await invoke(IPC.relay.pendingProposals)).toEqual([]);
    expect(await invoke(IPC.relay.decideProposal, 'x', false)).toBeNull();
    expect(live?.markDone).toHaveBeenCalledWith('r1', 'T001');
    expect(live?.reconcile).toHaveBeenCalledWith([{ legId: 'l1', tabId: 't1' }]);
  });

  it('redoes a task as a new attempt with another agent and starts it', async () => {
    const live = runtime();
    vi.mocked(live.start).mockResolvedValue({ ok: true, run: {} as never });
    await load(live);
    mkdirSync(join(folder, 'docs', 'tasks', 'handoffs'), { recursive: true });
    writeFileSync(
      join(folder, 'docs', 'tasks', 'handoffs', 'T001.md'),
      '---\ntask: T001\noutcome: blocked\n---\n\n## Purpose\n\nSign in.\n',
    );
    const result = await invoke(IPC.relay.redo, {
      projectId: 'p1',
      taskIds: ['T001'],
      agent: 'codex-cli',
      keepLearnings: true,
      start: true,
    });
    expect(result).toEqual({ redone: ['T001'], warnings: [], started: true });
    expect(live.start).toHaveBeenCalledWith({
      projectId: 'p1',
      only: ['T001'],
      trigger: { kind: 'now' },
    });
    const task = taskText('T001-login.md');
    expect(task).toContain('attempt: 2');
    expect(task).toContain('learnFrom: 1');
    expect(task).toContain('agent: codex-cli');
    expect(taskText(join('handoffs', 'archive', 'T001-attempt-1.md'))).toContain('Sign in.');
    await expect(
      invoke(IPC.relay.redo, {
        projectId: 'p1',
        taskIds: ['../T001'],
        agent: null,
        keepLearnings: false,
        start: false,
      }),
    ).rejects.toThrow();
  });

  it('says Relay is starting before the runtime is up', async () => {
    await load(null);
    await expect(invoke(IPC.relay.pause, 'r1')).rejects.toThrow(/starting/);
  });
});

describe('planning', () => {
  it('decomposes, revises and applies a proposal', async () => {
    await load();
    cli.run.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ summary: 'x', add: [{ title: 'Export', depends: ['T002'] }] }),
      cliName: 'Claude Code',
    });
    const planned = await invoke<RelayPlannerResult>(IPC.relay.decompose, {
      requestId: 'q1',
      projectId: 'p1',
      request: 'Export patients',
    });
    expect(planned).toMatchObject({ ok: true, entries: [{ kind: 'add', id: 'T003' }] });
    expect(
      await invoke<RelayPlannerResult>(IPC.relay.revise, { requestId: 'q2', projectId: 'p1' }),
    ).toMatchObject({ ok: true });
    await invoke(IPC.relay.cancelPlanner, 'q2');
    expect(cli.cancel).toHaveBeenCalledWith('q2');
    if (!planned.ok) throw new Error('planned');
    const applied = await invoke<{ written: string[] }>(
      IPC.relay.applyProposal,
      'p1',
      planned.proposal,
    );
    expect(applied.written).toEqual(['T003-export.md']);
    expect(taskText('T003-export.md')).toContain('depends: [T002]');
  });

  it('plans parts in plan mode and writes the plan, its records and its parts', async () => {
    await load();
    cli.run.mockResolvedValue({
      ok: true,
      text: JSON.stringify({
        summary: 'One part.',
        plan: { title: 'Search everywhere', goal: 'Find anything.' },
        milestones: [{ id: 'M001', title: 'First cut' }],
        questions: [{ title: 'Fuzzy or exact?' }],
        add: [{ title: 'Index', milestone: 'M001', context: 'Ten tables.' }],
      }),
      cliName: 'Claude Code',
    });
    const planned = await invoke<RelayPlannerResult>(IPC.relay.decompose, {
      requestId: 'q5',
      projectId: 'p1',
      request: 'Search everywhere',
      mode: 'plan',
    });
    expect(cli.run.mock.calls[0][0]).toMatch(/not by any context or token limit/);
    if (!planned.ok) throw new Error('planned');
    const applied = await invoke<{ written: string[]; items: string[]; plan: boolean }>(
      IPC.relay.applyProposal,
      'p1',
      planned.proposal,
      { mode: 'plan' },
    );
    expect(applied).toMatchObject({
      written: ['T003-index.md'],
      items: ['M001-first-cut.md', 'Q001-fuzzy-or-exact.md'],
      plan: true,
    });
    expect(taskText('PLAN.md')).toContain('mode: plan');
    expect(taskText('T003-index.md')).toContain('milestone: M001');
    expect(taskText(join('milestones', 'M001-first-cut.md'))).toContain('title: First cut');
    await expect(
      invoke(IPC.relay.applyProposal, 'p1', planned.proposal, { mode: 'later' }),
    ).rejects.toThrow();
  });

  it('tells a user who has moved to another app that the plan is ready', async () => {
    await load();
    electronState.notifications.length = 0;
    cli.run.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ summary: 'x', add: [{ title: 'Export' }] }),
      cliName: 'Claude Code',
    });
    await invoke(IPC.relay.decompose, { requestId: 'q9', projectId: 'p1', request: 'Export' });
    await vi.waitFor(() =>
      expect(JSON.stringify(electronState.notifications)).toContain('Tasks are ready to review'),
    );
  });

  it('catches up a project in progress, and refuses a request without the done choice', async () => {
    await load();
    cli.run.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ summary: 'x', add: [{ title: 'Export', status: 'done' }] }),
      cliName: 'Claude Code',
    });
    const planned = await invoke<RelayPlannerResult>(IPC.relay.catchUp, {
      requestId: 'q3',
      projectId: 'p1',
      recordDone: true,
    });
    expect(planned).toMatchObject({ ok: true, entries: [{ kind: 'add', status: 'done' }] });
    await expect(invoke(IPC.relay.catchUp, { requestId: 'q4', projectId: 'p1' })).rejects.toThrow();
  });
});
