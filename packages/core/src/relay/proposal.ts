import { z } from 'zod';
import {
  formatTokenCount,
  nextTaskId,
  parseTokenCount,
  renderHandoff,
  taskFileName,
} from './format.js';
import {
  renderTaskFile,
  setBodySection,
  setFrontMatterValue,
  setTaskStatus,
  taskGoal,
  yamlFlowList,
  yamlScalar,
} from './parse.js';
import {
  itemFileName,
  nextItemId,
  RELAY_LEVELS,
  type RelayItemKind,
  renderItemFile,
  renderPlanFile,
} from './plan.js';
import { RELAY_PRIORITIES, RELAY_SIZES, type RelayTask } from './types.js';

const idList = z
  .union([z.array(z.string()), z.string()])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(','))
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
  );

const tokens = z
  .union([z.number(), z.string(), z.null()])
  .transform((value) => parseTokenCount(value));

const text = z.string().transform((value) => value.trim());

/** Only finished work is recorded as such; anything a planner calls partial is still to do. */
const proposalStatus = z
  .string()
  .transform((value): 'todo' | 'done' => (value.trim().toLowerCase() === 'done' ? 'done' : 'todo'));

const handoffText = z
  .union([z.string(), z.null()])
  .transform((value) => value?.trim() ?? '')
  .optional();

/** A starting handoff for work done before Relay: Purpose comes from the task's goal. */
const proposalHandoff = z.object({
  done: handoffText,
  decisions: handoffText,
  rejected: handoffText,
  next: handoffText,
});

/**
 * A choice a planner may spell loosely (`P1`, `High`): lower-cased and matched, and dropped when it
 * is none of them, so one odd value never sinks the whole plan.
 */
function looseChoice<T extends string>(allowed: readonly T[], aliases: Record<string, T> = {}) {
  return z
    .unknown()
    .transform((value): T | undefined => {
      if (typeof value !== 'string' && typeof value !== 'number') return undefined;
      const word = String(value).trim().toLowerCase();
      if ((allowed as readonly string[]).includes(word)) return word as T;
      return aliases[word];
    })
    .optional();
}

const priority = looseChoice(RELAY_PRIORITIES, {
  critical: 'p0',
  high: 'p1',
  medium: 'p2',
  low: 'p3',
});
const size = looseChoice(RELAY_SIZES, { small: 's', medium: 'm', large: 'l' });
const level = looseChoice(RELAY_LEVELS, { med: 'medium' });

const taskFields = {
  title: z.string().trim().min(1, 'Every task needs a title.'),
  epic: z.string().trim().nullish(),
  order: z.number().nullish(),
  depends: idList.optional(),
  estimate: tokens.optional(),
  budget: tokens.optional(),
  specs: z.array(z.string()).optional(),
  priority,
  size,
  milestone: z.string().trim().toUpperCase().nullish(),
  labels: z.array(z.string()).optional(),
  goal: text.optional(),
  context: text.optional(),
  approach: text.optional(),
  interfaces: text.optional(),
  scope: text.optional(),
  outOfScope: text.optional(),
  acceptance: z.array(z.string()).optional(),
  testPlan: text.optional(),
  risks: text.optional(),
  status: proposalStatus.optional(),
  handoff: proposalHandoff.optional(),
};

const proposalTask = z.object({ id: z.string().trim().toUpperCase().optional(), ...taskFields });
const proposalChange = z
  .object(taskFields)
  .partial()
  .extend({ id: z.string().trim().toUpperCase() });

const proposalPlan = z.object({
  title: z.string().trim().min(1),
  goal: text.optional(),
  definitionOfDone: z.array(z.string()).optional(),
  outOfScope: text.optional(),
});

const proposalMilestone = z.object({
  id: z.string().trim().toUpperCase().optional(),
  title: z.string().trim().min(1, 'Every milestone needs a title.'),
  goal: text.optional(),
  target: z.string().trim().nullish(),
  exitCriteria: z.array(z.string()).optional(),
});

const proposalRisk = z.object({
  title: z.string().trim().min(1, 'Every risk needs a title.'),
  likelihood: level,
  impact: level,
  risk: text.optional(),
  mitigation: text.optional(),
});

const proposalQuestion = z.object({
  title: z.string().trim().min(1, 'Every question needs a title.'),
  question: text.optional(),
});

const proposalSchema = z.object({
  summary: z.string().optional().default(''),
  plan: proposalPlan.optional(),
  milestones: z.array(proposalMilestone).optional().default([]),
  risks: z.array(proposalRisk).optional().default([]),
  questions: z.array(proposalQuestion).optional().default([]),
  add: z.array(proposalTask).optional().default([]),
  change: z.array(proposalChange).optional().default([]),
  split: z
    .array(z.object({ id: z.string().trim().toUpperCase(), into: z.array(proposalTask).min(1) }))
    .optional()
    .default([]),
  remove: z
    .array(z.object({ id: z.string().trim().toUpperCase(), reason: z.string().optional() }))
    .optional()
    .default([]),
});

export type ProposalTask = z.infer<typeof proposalTask>;
export type ProposalChange = z.infer<typeof proposalChange>;
export interface ProposalSplit {
  id: string;
  into: ProposalTask[];
}
export interface ProposalRemoval {
  id: string;
  reason?: string;
}

/** What a planner proposes for the board. Nothing is written until the user applies it. */
export type ProposalPlanInfo = z.infer<typeof proposalPlan>;
export type ProposalMilestone = z.infer<typeof proposalMilestone>;
export type ProposalRisk = z.infer<typeof proposalRisk>;
export type ProposalQuestion = z.infer<typeof proposalQuestion>;

export interface RelayProposal {
  summary: string;
  /** Plan mode: the plan itself, written to PLAN.md when the project has none. */
  plan?: ProposalPlanInfo;
  milestones?: ProposalMilestone[];
  risks?: ProposalRisk[];
  questions?: ProposalQuestion[];
  add: ProposalTask[];
  change: ProposalChange[];
  split: ProposalSplit[];
  remove: ProposalRemoval[];
}

/** The JSON object in a planner's answer, which may come wrapped in a fence or a sentence. */
function extractJson(answer: string): string | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(answer)?.[1];
  const source = fenced ?? answer;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  return start !== -1 && end > start ? source.slice(start, end + 1) : null;
}

export function parsePlanProposal(
  answer: string,
): { ok: true; proposal: RelayProposal } | { ok: false; error: string } {
  const json = extractJson(answer);
  if (!json) return { ok: false, error: 'The answer had no JSON plan in it.' };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, error: 'The answer had JSON in it that could not be read.' };
  }
  const parsed = proposalSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length > 0 ? ` (at ${issue.path.join('.')})` : '';
    return {
      ok: false,
      error: `The plan does not have the expected shape: ${issue.message}${where}`,
    };
  }
  return { ok: true, proposal: parsed.data as RelayProposal };
}

export interface BoardFile {
  file: string;
  content: string;
  task: RelayTask;
}

export interface ProposalPlan {
  /** Files to create or overwrite, by name inside the tasks folder. */
  write: { file: string; content: string }[];
  /** Files to delete, by name inside the tasks folder. */
  remove: string[];
  /**
   * Starting handoffs, for work that was finished or begun before Relay. Main never writes one
   * over a handoff a session has filled in.
   */
  handoffs: { taskId: string; content: string }[];
  /** New milestones, risks and questions, by kind and file name inside the kind's folder. */
  items: { kind: RelayItemKind; file: string; content: string }[];
  /** PLAN.md for a plan-mode proposal. Main writes it only when the project has none. */
  plan: string | null;
  /** Parts of the proposal that were left out, and why. */
  warnings: string[];
}

export interface ApplyProposalOptions {
  /** The ids already used in each item folder, so new ones continue the numbering. */
  itemIds?: Partial<Record<RelayItemKind, readonly string[]>>;
  /** The plan's mode, written to a new PLAN.md. */
  mode?: 'fit' | 'plan';
  /** Today's date (`2026-11-28`), stamped on new records. */
  today?: string;
}

/**
 * Turns a proposal into file changes. New tasks get the next free ids (references between them
 * follow), done tasks are never touched, and the tasks that depended on a split or removed task
 * move onto its parts or lose the dependency.
 */
interface AssignedIds {
  /** The id each added task gets, in proposal order. */
  added: string[];
  /** The ids each split's parts get, by the id of the task split. Only splits that may happen. */
  parts: Map<string, string[]>;
  /** The proposal's own ids, mapped to the ids they become. */
  renamed: Map<string, string>;
}

/**
 * New tasks, and the parts of a split, get the next free ids in proposal order, whatever ids the
 * planner wrote. A planner can collide with the board or skip numbers; the board never does.
 */
function assignIds(board: readonly BoardFile[], proposal: RelayProposal): AssignedIds {
  const byId = new Map(board.map((entry) => [entry.task.id, entry.task]));
  const used = new Set(byId.keys());
  const renamed = new Map<string, string>();
  const take = (task: ProposalTask): string => {
    const id = nextTaskId(used);
    used.add(id);
    if (task.id) renamed.set(task.id, id);
    return id;
  };
  const added = proposal.add.map(take);
  const parts = new Map<string, string[]>();
  for (const split of proposal.split) {
    const original = byId.get(split.id);
    if (original && original.status !== 'done') parts.set(split.id, split.into.map(take));
  }
  return { added, parts, renamed };
}

/**
 * Gives every new task in a proposal the budget it was planned for, unless the planner set its
 * own. Without it a task runs with the project's default budget, not the one picked when it was
 * split.
 */
export function withBudget(proposal: RelayProposal, budget: number): RelayProposal {
  const fill = (task: ProposalTask): ProposalTask =>
    task.budget === undefined ? { ...task, budget } : task;
  return {
    ...proposal,
    add: proposal.add.map(fill),
    split: proposal.split.map((split) => ({ ...split, into: split.into.map(fill) })),
  };
}

/**
 * Milestones, risks and questions as files with the next free ids. A milestone the planner numbered
 * itself is renamed like a task, so the tasks that name it follow.
 */
function planItems(
  proposal: RelayProposal,
  options: ApplyProposalOptions,
): { items: ProposalPlan['items']; milestoneIds: Map<string, string> } {
  const items: ProposalPlan['items'] = [];
  const milestoneIds = new Map<string, string>();
  const used = (kind: RelayItemKind) => new Set(options.itemIds?.[kind] ?? []);
  const take = (kind: RelayItemKind, pool: Set<string>): string => {
    const id = nextItemId(kind, pool);
    pool.add(id);
    return id;
  };
  const created = options.today ?? null;

  const milestones = used('milestone');
  for (const milestone of proposal.milestones ?? []) {
    const id = take('milestone', milestones);
    if (milestone.id) milestoneIds.set(milestone.id, id);
    const exit = (milestone.exitCriteria ?? []).map((item) => item.trim()).filter(Boolean);
    items.push({
      kind: 'milestone',
      file: itemFileName(id, milestone.title),
      content: renderItemFile({
        kind: 'milestone',
        id,
        title: milestone.title,
        created,
        target: milestone.target ?? null,
        sections: {
          Goal: milestone.goal ?? '',
          'Exit criteria': exit.map((item) => `- [ ] ${item}`).join('\n'),
        },
      }),
    });
  }
  const risks = used('risk');
  for (const risk of proposal.risks ?? []) {
    const id = take('risk', risks);
    items.push({
      kind: 'risk',
      file: itemFileName(id, risk.title),
      content: renderItemFile({
        kind: 'risk',
        id,
        title: risk.title,
        created,
        likelihood: risk.likelihood ?? null,
        impact: risk.impact ?? null,
        sections: { Risk: risk.risk ?? '', Mitigation: risk.mitigation ?? '' },
      }),
    });
  }
  const questions = used('question');
  for (const question of proposal.questions ?? []) {
    const id = take('question', questions);
    items.push({
      kind: 'question',
      file: itemFileName(id, question.title),
      content: renderItemFile({
        kind: 'question',
        id,
        title: question.title,
        created,
        sections: { Question: question.question ?? '' },
      }),
    });
  }
  return { items, milestoneIds };
}

function planFile(proposal: RelayProposal, options: ApplyProposalOptions): string | null {
  if (!proposal.plan) return null;
  return renderPlanFile({
    title: proposal.plan.title,
    mode: options.mode ?? 'fit',
    keepRolling: options.mode === 'plan',
    runPastBudget: options.mode === 'plan',
    goal: proposal.plan.goal,
    definitionOfDone: proposal.plan.definitionOfDone,
    outOfScope: proposal.plan.outOfScope,
  });
}

export function applyProposal(
  board: readonly BoardFile[],
  proposal: RelayProposal,
  options: ApplyProposalOptions = {},
): ProposalPlan {
  const byId = new Map(board.map((entry) => [entry.task.id, entry]));
  const warnings: string[] = [];
  const { items, milestoneIds } = planItems(proposal, options);
  const knownMilestones = new Set([
    ...(options.itemIds?.milestone ?? []),
    ...milestoneIds.values(),
  ]);
  /** A task's milestone as it will be named, or null when it names none that exists. */
  const milestoneOf = (owner: string, named: string | null | undefined): string | null => {
    if (!named) return null;
    const id = milestoneIds.get(named) ?? named;
    if (knownMilestones.has(id)) return id;
    warnings.push(`${owner} named milestone ${named}, which does not exist; that was dropped.`);
    return null;
  };
  const isDone = (id: string): boolean => byId.get(id)?.task.status === 'done';
  const { added, parts, renamed } = assignIds(board, proposal);
  const newIds = new Set([...added, ...[...parts.values()].flat()]);

  const newTasks: { id: string; task: ProposalTask; inherit: string[] }[] = proposal.add.map(
    (task, index) => ({ id: added[index], task, inherit: [] }),
  );
  const removed = new Set<string>();
  const replacedBy = new Map<string, string[]>();
  for (const split of proposal.split) {
    const original = byId.get(split.id);
    const ids = parts.get(split.id);
    if (!original || !ids) {
      warnings.push(
        original
          ? `${split.id} is done, so it was not split.`
          : `${split.id} is not on the board, so it was not split.`,
      );
      continue;
    }
    split.into.forEach((task, index) => {
      newTasks.push({ id: ids[index], task, inherit: original.task.depends });
    });
    removed.add(split.id);
    replacedBy.set(split.id, ids);
  }
  for (const removal of proposal.remove) {
    if (!byId.has(removal.id)) {
      warnings.push(`${removal.id} is not on the board, so it was not removed.`);
    } else if (isDone(removal.id)) {
      warnings.push(`${removal.id} is done, so it was not removed.`);
    } else {
      removed.add(removal.id);
    }
  }

  /**
   * Maps dependencies onto real ids. Ids the proposal wrote may name its own new tasks, so those
   * go through the renames first; a board task's existing dependencies only follow splits and
   * removals.
   */
  const resolve = (depends: readonly string[], owner: string, fromProposal: boolean): string[] => {
    const out: string[] = [];
    for (const dep of depends) {
      const target = (fromProposal && renamed.get(dep)) || dep;
      const expanded = replacedBy.get(target) ?? [target];
      for (const id of expanded) {
        if (id === owner || removed.has(id)) continue;
        if (!byId.has(id) && !newIds.has(id)) {
          warnings.push(`${owner} depended on ${dep}, which does not exist; that was dropped.`);
          continue;
        }
        if (!out.includes(id)) out.push(id);
      }
    }
    return out;
  };

  const handoffs: ProposalPlan['handoffs'] = [];
  const write: ProposalPlan['write'] = newTasks.map(({ id, task, inherit }) => {
    const own = Boolean(task.depends?.length);
    const depends = resolve(own ? (task.depends ?? []) : inherit, id, own);
    const status = task.status ?? 'todo';
    if (task.handoff) {
      handoffs.push(startingHandoff(id, status, task.goal || task.title, task.handoff));
    }
    return {
      file: taskFileName(id, task.title),
      content: renderTaskFile({
        ...task,
        id,
        status,
        depends,
        milestone: milestoneOf(id, task.milestone),
      }),
    };
  });

  const changes = new Map<string, ProposalChange>();
  for (const change of proposal.change) {
    if (!byId.has(change.id))
      warnings.push(`${change.id} is not on the board, so it was not changed.`);
    else if (isDone(change.id)) warnings.push(`${change.id} is done, so it was not changed.`);
    else if (removed.has(change.id))
      warnings.push(`${change.id} is split or removed, so it was not changed.`);
    else changes.set(change.id, change);
  }

  for (const entry of board) {
    const { task } = entry;
    if (removed.has(task.id) || task.status === 'done') continue;
    const change = changes.get(task.id);
    const depends = change?.depends
      ? resolve(change.depends, task.id, true)
      : resolve(task.depends, task.id, false);
    const dependsChanged = depends.join(',') !== task.depends.join(',');
    if (!change && !dependsChanged) continue;

    let content = entry.content;
    if (dependsChanged || change?.depends) {
      content = setFrontMatterValue(
        content,
        'depends',
        depends.length > 0 ? yamlFlowList(depends) : null,
      );
    }
    if (change) {
      content = applyChange(content, change);
      if (change.milestone !== undefined) {
        content = setFrontMatterValue(content, 'milestone', milestoneOf(task.id, change.milestone));
      }
    }
    if (change?.handoff) {
      const status = change.status ?? 'todo';
      handoffs.push(
        startingHandoff(task.id, status, change.goal || taskGoal(task), change.handoff),
      );
    }
    write.push({ file: entry.file, content });
  }

  const remove = board.filter((entry) => removed.has(entry.task.id)).map((entry) => entry.file);
  return { write, remove, warnings, handoffs, items, plan: planFile(proposal, options) };
}

function startingHandoff(
  taskId: string,
  status: 'todo' | 'done',
  purpose: string,
  handoff: NonNullable<ProposalTask['handoff']>,
): ProposalPlan['handoffs'][number] {
  return {
    taskId,
    content: renderHandoff({
      id: taskId,
      outcome: status === 'done' ? 'done' : 'continue',
      sections: { purpose, ...handoff },
    }),
  };
}

/** A finished task's criteria are met, so its boxes are ticked. */
function tickCriteria(content: string): string {
  return content.replace(/^(\s*[-*]\s+)\[ \]/gm, '$1[x]');
}

function applyChange(content: string, change: ProposalChange): string {
  let next = content;
  if (change.title) next = setFrontMatterValue(next, 'title', yamlScalar(change.title));
  if (change.epic !== undefined)
    next = setFrontMatterValue(next, 'epic', change.epic ? yamlScalar(change.epic) : null);
  if (change.order !== undefined)
    next = setFrontMatterValue(next, 'order', change.order === null ? null : String(change.order));
  if (change.estimate !== undefined) {
    next = setFrontMatterValue(
      next,
      'estimate',
      change.estimate === null ? null : String(change.estimate),
    );
  }
  if (change.budget !== undefined) {
    next = setFrontMatterValue(
      next,
      'budget',
      change.budget === null ? null : String(change.budget),
    );
  }
  if (change.specs)
    next = setFrontMatterValue(
      next,
      'specs',
      change.specs.length > 0 ? yamlFlowList(change.specs) : null,
    );
  if (change.priority) next = setFrontMatterValue(next, 'priority', change.priority);
  if (change.size) next = setFrontMatterValue(next, 'size', change.size);
  if (change.labels)
    next = setFrontMatterValue(
      next,
      'labels',
      change.labels.length > 0 ? yamlFlowList(change.labels) : null,
    );
  if (change.goal) next = setBodySection(next, 'Goal', change.goal);
  if (change.context) next = setBodySection(next, 'Context', change.context);
  if (change.approach) next = setBodySection(next, 'Approach', change.approach);
  if (change.interfaces) next = setBodySection(next, 'Interfaces and files', change.interfaces);
  if (change.scope) next = setBodySection(next, 'Scope', change.scope);
  if (change.outOfScope) next = setBodySection(next, 'Out of scope', change.outOfScope);
  if (change.risks) next = setBodySection(next, 'Risks', change.risks);
  if (change.acceptance?.length) {
    next = setBodySection(
      next,
      'Acceptance criteria',
      change.acceptance.map((item) => `- [ ] ${item.trim()}`).join('\n'),
    );
  }
  if (change.testPlan) next = setBodySection(next, 'Test plan', change.testPlan);
  if (change.status) {
    next = setTaskStatus(next, change.status);
    if (change.status === 'done') next = tickCriteria(next);
  }
  return next;
}

export interface ProposalFieldChange {
  field: string;
  before: string;
  after: string;
}

export interface ProposalEntry {
  kind: 'add' | 'change' | 'split' | 'remove';
  id: string;
  title: string;
  fields: ProposalFieldChange[];
  /** The parts a split makes, as the proposal names them. */
  parts?: { id: string; title: string }[];
  reason?: string;
  /** A new task's status, when the proposal records it as finished (or says it is to do). */
  status?: 'todo' | 'done';
  /** The entry comes with a starting handoff. */
  handoff?: boolean;
}

function show(field: string, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join(field === 'acceptance' ? '; ' : ', ');
  if ((field === 'estimate' || field === 'budget') && typeof value === 'number') {
    return formatTokenCount(value);
  }
  return String(value);
}

const DIFF_FIELDS = [
  'status',
  'title',
  'epic',
  'depends',
  'estimate',
  'budget',
  'priority',
  'size',
  'milestone',
  'goal',
  'scope',
  'acceptance',
  'testPlan',
] as const;

/** What a proposal would do, entry by entry, for the review step before anything is applied. */
export function diffProposal(
  board: readonly BoardFile[],
  proposal: RelayProposal,
): ProposalEntry[] {
  const byId = new Map(board.map((entry) => [entry.task.id, entry.task]));
  const ids = assignIds(board, proposal);
  const entries: ProposalEntry[] = proposal.add.map((task, index) => ({
    kind: 'add',
    id: ids.added[index],
    title: task.title,
    fields: [],
    ...(task.status ? { status: task.status } : {}),
    ...(task.handoff ? { handoff: true } : {}),
  }));
  for (const change of proposal.change) {
    const task = byId.get(change.id);
    const before: Record<string, unknown> = task
      ? {
          status: task.status,
          title: task.title,
          epic: task.epic,
          depends: task.depends,
          estimate: task.estimate,
          budget: task.budget,
          priority: task.priority,
          size: task.size,
          milestone: task.milestone,
        }
      : {};
    const fields: ProposalFieldChange[] = [];
    for (const field of DIFF_FIELDS) {
      const after = change[field];
      if (after === undefined) continue;
      const was = show(field, before[field]);
      const now = show(field, after);
      if (was !== now) fields.push({ field, before: was, after: now });
    }
    entries.push({
      kind: 'change',
      id: change.id,
      title: change.title ?? task?.title ?? change.id,
      fields,
      ...(change.handoff ? { handoff: true } : {}),
    });
  }
  for (const split of proposal.split) {
    const partIds = ids.parts.get(split.id);
    entries.push({
      kind: 'split',
      id: split.id,
      title: byId.get(split.id)?.title ?? split.id,
      fields: [],
      parts: split.into.map((task, index) => ({ id: partIds?.[index] ?? '', title: task.title })),
    });
  }
  for (const removal of proposal.remove) {
    entries.push({
      kind: 'remove',
      id: removal.id,
      title: byId.get(removal.id)?.title ?? removal.id,
      fields: [],
      reason: removal.reason,
    });
  }
  return entries;
}
