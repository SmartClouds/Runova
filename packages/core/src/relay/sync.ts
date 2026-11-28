import { RELAY_ITEM_SPECS, type RelayItem, type RelayItemKind, type RelayPlan } from './plan.js';
import type { RelayTask } from './types.js';

/**
 * Plan sync through git (E123): the summary Runova keeps in STATUS.md and the messages of the
 * commits it makes for the plan folder. Both are pure and stable, so the same plan always gives the
 * same file, and an unchanged plan never makes a commit.
 */

export const RELAY_STATUS_FILE = 'STATUS.md';

type StatusTask = Pick<RelayTask, 'id' | 'title' | 'status' | 'milestone' | 'priority'>;

function percent(done: number, total: number): string {
  return total === 0 ? '0%' : `${Math.round((done / total) * 100)}%`;
}

/**
 * STATUS.md: where the plan stands, readable on GitHub and in a diff. It holds no time of its own,
 * so it changes only when the plan does.
 */
export function renderStatusFile(input: {
  plan: RelayPlan | null;
  tasks: readonly StatusTask[];
  items: Record<RelayItemKind, readonly RelayItem[]>;
}): string {
  const { plan, tasks, items } = input;
  const done = tasks.filter((task) => task.status === 'done').length;
  const count = (status: StatusTask['status']) =>
    tasks.filter((task) => task.status === status).length;
  const lines = [
    `# Status${plan ? `: ${plan.title}` : ''}`,
    '',
    'Runova keeps this file from the plan and its tasks. Edit those, not this.',
    '',
    `**${done} of ${tasks.length} tasks done (${percent(done, tasks.length)}).** To do ${count('todo')}, in progress ${count('in-progress')}, testing ${count('testing')}, blocked ${count('blocked')}.`,
  ];

  const milestones = [...items.milestone].sort((a, b) =>
    a.id.localeCompare(b.id, 'en', { numeric: true }),
  );
  if (milestones.length > 0) {
    lines.push(
      '',
      '## Milestones',
      '',
      '| Milestone | Status | Target | Done |',
      '|---|---|---|---|',
    );
    for (const milestone of milestones) {
      const own = tasks.filter((task) => task.milestone === milestone.id);
      const ownDone = own.filter((task) => task.status === 'done').length;
      lines.push(
        `| ${milestone.id} ${milestone.title} | ${milestone.status} | ${milestone.target ?? ''} | ${ownDone} of ${own.length} |`,
      );
    }
  }

  const blocked = tasks.filter((task) => task.status === 'blocked' || task.status === 'testing');
  if (blocked.length > 0) {
    lines.push('', '## Needs attention', '');
    for (const task of blocked) {
      lines.push(
        `- ${task.id} ${task.title} (${task.status === 'blocked' ? 'blocked' : 'tests fail'})`,
      );
    }
  }

  const open: [RelayItemKind, string][] = [
    ['question', 'open'],
    ['workaround', 'open'],
    ['risk', 'open'],
  ];
  for (const [kind, status] of open) {
    const list = items[kind].filter((item) => item.status === status);
    if (list.length === 0) continue;
    lines.push('', `## Open ${RELAY_ITEM_SPECS[kind].plural.toLowerCase()}`, '');
    for (const item of list) {
      const extra =
        kind === 'workaround' && item.dependency && item.waitingFor
          ? ` (waits for ${item.dependency} ${item.waitingFor})`
          : kind === 'risk' && item.impact
            ? ` (impact ${item.impact})`
            : '';
      lines.push(`- ${item.id} ${item.title}${extra}`);
    }
  }

  const decisions = items.decision.filter((item) => item.status === 'accepted').length;
  if (decisions > 0) lines.push('', `${decisions} decisions are recorded in decisions/.`);
  return `${lines.join('\n')}\n`;
}

/** One line of `git status --porcelain` for a file in the plan folder. */
export interface PlanFileChange {
  /** The two status letters, such as ` M`, `??` or ` D`. */
  code: string;
  /** The path relative to the tasks folder, posix style. */
  path: string;
}

const ID_IN_NAME = /(?:^|\/)([TMDWRQ]\d{3,})(?:[-.]|$)/;

function idOf(path: string): string | null {
  return ID_IN_NAME.exec(path)?.[1] ?? null;
}

/**
 * The message of a plan commit, built from what changed: `docs(tasks): add W003, update T012`.
 * Journals, handoffs and STATUS.md alone read as a progress update.
 */
export function planCommitMessage(changes: readonly PlanFileChange[]): string {
  const added = new Set<string>();
  const removed = new Set<string>();
  const updated = new Set<string>();
  let plan = false;
  for (const change of changes) {
    if (change.path === 'PLAN.md') {
      plan = true;
      continue;
    }
    // Journals and handoffs follow the work; they name no change of their own.
    if (/^(journal|handoffs)\//.test(change.path) || change.path === RELAY_STATUS_FILE) continue;
    const id = idOf(change.path);
    if (!id) continue;
    const code = change.code.trim();
    if (code === '??' || code.startsWith('A')) added.add(id);
    else if (code.includes('D')) removed.add(id);
    else updated.add(id);
  }
  for (const id of [...added, ...removed]) updated.delete(id);
  const sorted = (set: Set<string>) =>
    [...set].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const parts = [
    plan ? 'update the plan' : null,
    added.size > 0 ? `add ${sorted(added).join(', ')}` : null,
    updated.size > 0 ? `update ${sorted(updated).join(', ')}` : null,
    removed.size > 0 ? `remove ${sorted(removed).join(', ')}` : null,
  ].filter((part): part is string => part !== null);
  const summary = parts.length > 0 ? parts.join(', ') : 'record progress';
  const subject = `docs(tasks): ${summary}`;
  return subject.length <= 100 ? subject : `${subject.slice(0, 96).replace(/,?\s*\S*$/, '')} ...`;
}

/** Ids used by more than one file of the same kind, as `{ id, files }`, for a renumber. */
export function duplicateIds(names: readonly string[]): { id: string; files: string[] }[] {
  const byId = new Map<string, string[]>();
  for (const name of names) {
    const id = idOf(name);
    if (!id) continue;
    const list = byId.get(id) ?? [];
    list.push(name);
    byId.set(id, list);
  }
  return [...byId.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([id, files]) => ({ id, files: files.sort() }));
}
