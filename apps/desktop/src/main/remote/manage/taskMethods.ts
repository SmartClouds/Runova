import {
  bodySection,
  RELAY_ITEM_KINDS,
  RELAY_ITEM_SPECS,
  RELAY_LEVELS,
  RELAY_PRIORITIES,
  RELAY_SIZES,
  RELAY_TASK_STATUSES,
  type RelayItem,
  type RelayItemKind,
  type RelayProposal,
  type RelayTaskStatus,
} from '@runova/core';
import type {
  RelayApplyResult,
  RelayBoard,
  RelayDecomposeInput,
  RelayItemInput,
  RelayPlannerResult,
  RelayRedoInput,
  RelayRedoResult,
  RelayRunView,
  RelayStartResult,
  RelayTaskCard,
  RelayTaskDetail,
} from '../../../shared/relayTypes';
import {
  createTask,
  journalEntries,
  saveItem,
  saveTaskBody,
  toggleAcceptance,
  updateTask,
} from '../../relay/planEdits';
import { readAllItems, readPlan } from '../../relay/planFiles';
import type { RelayFolder } from '../../relay/taskFiles';
import { ManageError, type ManageMethods } from './session';

/**
 * The plan and its tasks on the phone (E124). The files stay on this computer; the phone reads
 * views built here and asks for changes, which go through the same writers as the desktop's
 * Tasks views and are committed the same way. Nothing here takes a path from the phone: projects
 * and tasks are named by id and checked against their patterns.
 */
export interface ManageTaskDeps {
  folder(projectId: string): Promise<RelayFolder>;
  board(projectId: string): Promise<RelayBoard>;
  detail(projectId: string, taskId: string): Promise<RelayTaskDetail | null>;
  setStatus(projectId: string, taskId: string, status: RelayTaskStatus): Promise<void>;
  decompose(input: RelayDecomposeInput): Promise<RelayPlannerResult>;
  cancelPlanner(requestId: string): void;
  applyProposal(
    projectId: string,
    proposal: RelayProposal,
    mode: 'fit' | 'plan',
  ): Promise<RelayApplyResult>;
  redo(input: RelayRedoInput): Promise<RelayRedoResult>;
  start(projectId: string): Promise<RelayStartResult>;
  pause(relayId: string): Promise<void>;
  resume(relayId: string): Promise<void>;
  active(projectId: string): RelayRunView | null;
  /** Tells the windows and schedules the plan commit, as an edit on the desktop does. */
  changed(projectId: string): void;
}

const PROJECT = /^\S[^\0]{0,199}$/;
const TASK = /^T\d{3,}$/;
const ITEM = /^[MDWRQ]\d{3,}$/;
const REQUEST = /^[A-Za-z0-9_-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function params(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function matching(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ManageError('bad-params', `That is not a ${what}.`);
  }
  return value;
}

function text(value: unknown, what: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ManageError('bad-params', `The ${what} is missing.`);
    return undefined;
  }
  if (typeof value !== 'string' || value.length > max) {
    throw new ManageError('bad-params', `The ${what} is too long or not text.`);
  }
  return value;
}

function choice<T extends string>(value: unknown, allowed: readonly T[], what: string): T | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ManageError('bad-params', `That is not a ${what}.`);
  }
  return value as T;
}

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ManageError) throw error;
    throw new ManageError('failed', error instanceof Error ? error.message : String(error));
  }
}

const STATUS_WORDS: Record<RelayTaskStatus, string> = {
  todo: 'To do',
  'in-progress': 'In progress',
  testing: 'Testing',
  done: 'Done',
  blocked: 'Blocked',
};

function row(task: RelayTaskCard) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    statusLabel: STATUS_WORDS[task.status],
    priority: task.priority,
    size: task.size,
    milestone: task.milestone,
    labels: task.labels,
    due: task.due,
    agent: task.agent,
    checked: task.acceptance.checked,
    total: task.acceptance.total,
  };
}

function sections(body: string): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = [];
  for (const match of body.matchAll(/^#{1,4}\s+(.+?)\s*#*\s*$/gm)) {
    const heading = match[1];
    const value = bodySection(body, heading);
    if (value) out.push({ heading, text: value });
  }
  return out;
}

function acceptance(body: string): { text: string; checked: boolean }[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,4}\s+.*acceptance/i.test(line));
  let scope = lines;
  if (start !== -1) {
    const end = lines.findIndex((line, index) => index > start && /^#{1,4}\s+/.test(line));
    scope = lines.slice(start + 1, end === -1 ? undefined : end);
  }
  return scope.flatMap((line) => {
    const match = /^\s*[-*+]\s+\[( |x|X)\]\s*(.*)$/.exec(line);
    return match ? [{ text: match[2].trim(), checked: match[1] !== ' ' }] : [];
  });
}

const DETAIL_FIELDS: { key: keyof RelayItem; label: string }[] = [
  { key: 'task', label: 'From task' },
  { key: 'target', label: 'Target' },
  { key: 'dependency', label: 'Waits on' },
  { key: 'waitingFor', label: 'Fixed in' },
  { key: 'revisitBy', label: 'Look again by' },
  { key: 'likelihood', label: 'Likelihood' },
  { key: 'impact', label: 'Impact' },
  { key: 'owner', label: 'Owner' },
];

function itemView(item: RelayItem) {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    statuses: [...RELAY_ITEM_SPECS[item.kind].statuses],
    details: DETAIL_FIELDS.flatMap(({ key, label }) => {
      const value = item[key];
      return typeof value === 'string' && value ? [{ label, value }] : [];
    }),
    sections: RELAY_ITEM_SPECS[item.kind].sections.flatMap((section) => {
      const value = bodySection(item.body, section.heading);
      return value ? [{ heading: section.heading, text: value }] : [];
    }),
  };
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ok = (message: string, extra: Record<string, unknown> = {}) => ({
  ok: true,
  message,
  ...extra,
});

export function taskMethods(deps: ManageTaskDeps): ManageMethods['calls'] {
  const project = (p: unknown) => matching(params(p).projectId, PROJECT, 'project');
  const task = (p: unknown) => matching(params(p).taskId, TASK, 'task id');
  const edit = async <T>(projectId: string, work: (folder: RelayFolder) => Promise<T>) =>
    run(async () => {
      const result = await work(await deps.folder(projectId));
      deps.changed(projectId);
      return result;
    });

  return {
    'tasks.overview': (p) =>
      run(async () => {
        const projectId = project(p);
        const [board, folder] = await Promise.all([deps.board(projectId), deps.folder(projectId)]);
        const [plan, items] = await Promise.all([readPlan(folder), readAllItems(folder)]);
        const count = (status: RelayTaskStatus) =>
          board.tasks.filter((entry) => entry.status === status).length;
        const active = board.active ?? deps.active(projectId);
        return {
          exists: board.exists,
          plan: plan
            ? { title: plan.title, mode: plan.mode, goal: bodySection(plan.body, 'Goal') || null }
            : null,
          done: count('done'),
          total: board.tasks.length,
          counts: {
            todo: count('todo'),
            inProgress: count('in-progress'),
            testing: count('testing'),
            done: count('done'),
            blocked: count('blocked'),
          },
          milestones: items.milestone.map((milestone) => {
            const own = board.tasks.filter((entry) => entry.milestone === milestone.id);
            return {
              id: milestone.id,
              title: milestone.title,
              status: milestone.status,
              target: milestone.target,
              done: own.filter((entry) => entry.status === 'done').length,
              total: own.length,
            };
          }),
          needsYou: board.tasks
            .filter((entry) => entry.status === 'blocked' || entry.status === 'testing')
            .map(row),
          questions: items.question
            .filter((item) => item.status === 'open')
            .map((item) => ({ id: item.id, title: item.title })),
          workarounds: items.workaround.filter((item) => item.status === 'open').length,
          risks: items.risk.filter((item) => item.status === 'open').length,
          run: active
            ? { id: active.id, status: active.status, taskId: active.current?.taskId ?? null }
            : null,
        };
      }),
    'tasks.board': (p) => run(async () => (await deps.board(project(p))).tasks.map(row)),
    'tasks.detail': (p) =>
      run(async () => {
        const projectId = project(p);
        const taskId = task(p);
        const detail = await deps.detail(projectId, taskId);
        if (!detail) throw new ManageError('bad-params', `There is no task ${taskId}.`);
        const board = await deps.board(projectId);
        const card = board.tasks.find((entry) => entry.id === taskId);
        const journal = await journalEntries(await deps.folder(projectId), taskId);
        return {
          task: card ? row(card) : null,
          depends: detail.task.depends,
          attempt: detail.task.attempt,
          sections: sections(detail.task.body).filter(
            (section) => !/acceptance/i.test(section.heading),
          ),
          acceptance: acceptance(detail.task.body),
          body: detail.task.body,
          handoff: detail.handoff
            ? {
                outcome: detail.handoff.outcome,
                tests: detail.handoff.tests,
                leg: detail.handoff.leg,
                sections: Object.entries(detail.handoff.sections)
                  .filter(([, value]) => value)
                  .map(([key, value]) => ({ heading: key, text: value })),
              }
            : null,
          journal,
        };
      }),
    'tasks.items': (p) =>
      run(async () => {
        const projectId = project(p);
        const kind = choice(params(p).kind, RELAY_ITEM_KINDS, 'kind of record');
        if (!kind) throw new ManageError('bad-params', 'Say which kind of record.');
        const items = await readAllItems(await deps.folder(projectId));
        return items[kind].map(itemView);
      }),
    'tasks.create': (p) => {
      const projectId = project(p);
      const title = text(params(p).title, 'title', 300, true) as string;
      const priority = choice(params(p).priority, RELAY_PRIORITIES, 'priority');
      return edit(projectId, async (folder) => {
        const id = await createTask(folder, { title, priority });
        return ok(`Added ${id}.`, { id });
      });
    },
    'tasks.update': (p) => {
      const projectId = project(p);
      const taskId = task(p);
      const patch = params(params(p).patch);
      const due = text(patch.due, 'due date', 10);
      if (due && !DATE.test(due))
        throw new ManageError('bad-params', 'Write the date as YYYY-MM-DD.');
      const milestone = patch.milestone
        ? matching(patch.milestone, /^M\d{3,}$/, 'milestone')
        : patch.milestone;
      return edit(projectId, async (folder) => {
        await updateTask(folder, taskId, {
          ...(patch.title !== undefined ? { title: text(patch.title, 'title', 300, true) } : {}),
          ...(patch.priority !== undefined
            ? { priority: choice(patch.priority, RELAY_PRIORITIES, 'priority') }
            : {}),
          ...(patch.size !== undefined ? { size: choice(patch.size, RELAY_SIZES, 'size') } : {}),
          ...(patch.milestone !== undefined
            ? { milestone: (milestone as string | null) ?? null }
            : {}),
          ...(patch.due !== undefined ? { due: due ?? null } : {}),
        });
        return ok(`Saved ${taskId}.`);
      });
    },
    'tasks.setStatus': (p) => {
      const projectId = project(p);
      const taskId = task(p);
      const status = choice(params(p).status, RELAY_TASK_STATUSES, 'status');
      if (!status) throw new ManageError('bad-params', 'Say which status.');
      return run(async () => {
        await deps.setStatus(projectId, taskId, status);
        deps.changed(projectId);
        return ok(`${taskId} is ${STATUS_WORDS[status].toLowerCase()}.`);
      });
    },
    'tasks.toggleAcceptance': (p) => {
      const projectId = project(p);
      const taskId = task(p);
      const index = params(p).index;
      const checked = params(p).checked;
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > 500) {
        throw new ManageError('bad-params', 'That is not a criterion.');
      }
      if (typeof checked !== 'boolean') throw new ManageError('bad-params', 'Say ticked or not.');
      return edit(projectId, async (folder) => {
        await toggleAcceptance(folder, taskId, index as number, checked);
        return ok(checked ? 'Ticked.' : 'Unticked.');
      });
    },
    'tasks.saveBody': (p) => {
      const projectId = project(p);
      const taskId = task(p);
      const body = text(params(p).body, 'spec', 200_000, true) as string;
      return edit(projectId, async (folder) => {
        await saveTaskBody(folder, taskId, body);
        return ok(`Saved the spec of ${taskId}.`);
      });
    },
    'tasks.saveItem': (p) => {
      const projectId = project(p);
      const raw = params(params(p).item);
      const kind = choice(raw.kind, RELAY_ITEM_KINDS, 'kind of record') as RelayItemKind | null;
      if (!kind) throw new ManageError('bad-params', 'Say which kind of record.');
      const id = raw.id === undefined ? undefined : matching(raw.id, ITEM, 'record id');
      const status = text(raw.status, 'status', 40);
      if (status && !RELAY_ITEM_SPECS[kind].statuses.includes(status)) {
        throw new ManageError('bad-params', 'That is not a status for this record.');
      }
      const sectionsIn = params(raw.sections);
      const allowed = new Set(RELAY_ITEM_SPECS[kind].sections.map((section) => section.heading));
      const sectionText: Record<string, string> = {};
      for (const [heading, value] of Object.entries(sectionsIn)) {
        if (!allowed.has(heading))
          throw new ManageError('bad-params', `${heading} is not a section here.`);
        sectionText[heading] = text(value, heading, 20_000) ?? '';
      }
      const fields = params(raw.fields);
      const level = (value: unknown) => choice(value, RELAY_LEVELS, 'level');
      const input: RelayItemInput = {
        kind,
        ...(id ? { id } : {}),
        ...(raw.title !== undefined ? { title: text(raw.title, 'title', 300, true) } : {}),
        ...(status ? { status } : {}),
        fields: {
          ...(fields.task !== undefined
            ? { task: fields.task ? matching(fields.task, TASK, 'task id') : null }
            : {}),
          ...(fields.likelihood !== undefined ? { likelihood: level(fields.likelihood) } : {}),
          ...(fields.impact !== undefined ? { impact: level(fields.impact) } : {}),
          ...(fields.dependency !== undefined
            ? { dependency: text(fields.dependency, 'package', 200) ?? null }
            : {}),
          ...(fields.waitingFor !== undefined
            ? { waitingFor: text(fields.waitingFor, 'version', 200) ?? null }
            : {}),
        },
        sections: sectionText,
      };
      if (!id && !input.title) throw new ManageError('bad-params', 'A new record needs a title.');
      return edit(projectId, async (folder) => {
        const saved = await saveItem(folder, input);
        return ok(`Saved ${saved}.`, { id: saved });
      });
    },
    'tasks.split': (p) =>
      run(async () => {
        const projectId = project(p);
        const request = text(params(p).request, 'request', 100_000, true) as string;
        const requestId = matching(params(p).requestId, REQUEST, 'request id');
        const mode = choice(params(p).mode, ['fit', 'plan'] as const, 'mode') ?? 'fit';
        const result = await deps.decompose({ requestId, projectId, request, mode });
        if (!result.ok)
          return { ok: false, error: result.error, summary: '', entries: [], proposal: null };
        const proposal = result.proposal;
        const extras = [
          proposal.plan ? 'the plan' : null,
          proposal.milestones?.length ? count(proposal.milestones.length, 'milestone') : null,
          proposal.risks?.length ? count(proposal.risks.length, 'risk') : null,
          proposal.questions?.length ? count(proposal.questions.length, 'question') : null,
        ].filter(Boolean);
        return {
          ok: true,
          error: null,
          summary: proposal.summary,
          entries: result.entries.map((entry) => ({
            kind: entry.kind,
            id: entry.id,
            title: entry.title,
          })),
          extras: extras.length > 0 ? `Also writes ${extras.join(', ')}.` : null,
          proposal,
        };
      }),
    'tasks.cancelSplit': (p) => {
      deps.cancelPlanner(matching(params(p).requestId, REQUEST, 'request id'));
      return ok('Stopped planning.');
    },
    'tasks.applyProposal': (p) => {
      const projectId = project(p);
      const proposal = params(p).proposal;
      if (
        !proposal ||
        typeof proposal !== 'object' ||
        !Array.isArray((proposal as RelayProposal).add)
      ) {
        throw new ManageError('bad-params', 'That is not a plan.');
      }
      if (JSON.stringify(proposal).length > 500_000)
        throw new ManageError('bad-params', 'That plan is too big.');
      const mode = choice(params(p).mode, ['fit', 'plan'] as const, 'mode') ?? 'fit';
      return run(async () => {
        const result = await deps.applyProposal(projectId, proposal as RelayProposal, mode);
        deps.changed(projectId);
        const added = result.written.length;
        return ok(`Added ${added} task${added === 1 ? '' : 's'} to the board.`, {
          warnings: result.warnings,
        });
      });
    },
    'tasks.redo': (p) => {
      const projectId = project(p);
      const taskIds = params(p).taskIds;
      const ids =
        taskIds === 'all'
          ? 'all'
          : Array.isArray(taskIds) && taskIds.length > 0 && taskIds.length <= 500
            ? taskIds.map((id) => matching(id, TASK, 'task id'))
            : null;
      if (!ids) throw new ManageError('bad-params', 'Say which tasks to redo.');
      const agent = text(params(p).agent, 'agent', 64) ?? null;
      const keepLearnings = params(p).keepLearnings === true;
      const start = params(p).start === true;
      return run(async () => {
        const result = await deps.redo({ projectId, taskIds: ids, agent, keepLearnings, start });
        deps.changed(projectId);
        if (result.error) return { ok: false, message: result.error };
        return ok(
          result.redone.length === 0
            ? (result.warnings[0] ?? 'Nothing was redone.')
            : `${result.redone.join(', ')} ${result.started ? 'started again' : 'will start over'}.`,
        );
      });
    },
    'tasks.start': (p) =>
      run(async () => {
        const result = await deps.start(project(p));
        return result.ok ? ok('The relay started.') : { ok: false, message: result.error };
      }),
    'tasks.pause': (p) =>
      run(async () => {
        const active = deps.active(project(p));
        if (!active) return { ok: false, message: 'No relay is running on this project.' };
        await deps.pause(active.id);
        return ok('The relay pauses after the session it is on.');
      }),
    'tasks.resume': (p) =>
      run(async () => {
        const active = deps.active(project(p));
        if (!active) return { ok: false, message: 'No relay is waiting on this project.' };
        await deps.resume(active.id);
        return ok('The relay goes on.');
      }),
  };
}
