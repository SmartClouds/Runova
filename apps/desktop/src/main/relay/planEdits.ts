import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isRelayItemId,
  isRelayTaskId,
  itemFileName,
  nextItemId,
  nextTaskId,
  parseJournal,
  RELAY_ITEM_SPECS,
  type RelayItemKind,
  renderItemFile,
  renderPlanFile,
  renderTaskFile,
  setBodySection,
  setFrontMatterValue,
  splitFrontMatter,
  taskFileName,
  taskFromWorkaround,
  yamlFlowList,
  yamlScalar,
} from '@runova/core';
import type {
  RelayItemInput,
  RelayPlanInput,
  RelayTaskInput,
  RelayTaskPatch,
} from '../../shared/relayTypes';
import { itemIds, planPath, readItems, readJournal, writeItemFile } from './planFiles';
import { type RelayFolder, readBoardFiles, writeAtomic } from './taskFiles';

/**
 * Edits made by hand in the Tasks views (E122), from the desktop or the phone. Each one changes
 * only the lines it is about, so a file a person or an agent wrote keeps its formatting, comments
 * and everything else. Ids are checked against their patterns before any path is built.
 */

async function taskFile(folder: RelayFolder, taskId: string) {
  if (!isRelayTaskId(taskId)) throw new Error(`"${taskId}" is not a task id.`);
  const file = (await readBoardFiles(folder)).files.find((entry) => entry.task.id === taskId);
  if (!file) throw new Error(`There is no task ${taskId}.`);
  return file;
}

function scalarOrNull(value: string | null | undefined): string | null {
  return value?.trim() ? yamlScalar(value.trim()) : null;
}

function listOrNull(values: readonly string[] | undefined): string | null {
  const clean = (values ?? []).map((value) => value.trim()).filter(Boolean);
  return clean.length > 0 ? yamlFlowList([...new Set(clean)]) : null;
}

/** Changes a task's front matter fields; a field set to null or empty is removed. */
export async function updateTask(
  folder: RelayFolder,
  taskId: string,
  patch: RelayTaskPatch,
): Promise<void> {
  const file = await taskFile(folder, taskId);
  let content = file.content;
  const set = (key: string, value: string | null) => {
    content = setFrontMatterValue(content, key, value);
  };
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new Error('A task needs a title.');
    set('title', yamlScalar(patch.title.trim()));
  }
  if (patch.epic !== undefined) set('epic', scalarOrNull(patch.epic));
  if (patch.priority !== undefined) set('priority', patch.priority);
  if (patch.size !== undefined) set('size', patch.size);
  if (patch.milestone !== undefined) set('milestone', patch.milestone);
  if (patch.labels !== undefined) set('labels', listOrNull(patch.labels));
  if (patch.agent !== undefined) set('agent', scalarOrNull(patch.agent));
  if (patch.due !== undefined) set('due', scalarOrNull(patch.due));
  if (patch.estimate !== undefined)
    set('estimate', patch.estimate === null ? null : String(patch.estimate));
  if (patch.budget !== undefined)
    set('budget', patch.budget === null ? null : String(patch.budget));
  if (patch.depends !== undefined) {
    const depends = patch.depends.filter((id) => isRelayTaskId(id) && id !== taskId);
    set('depends', depends.length > 0 ? yamlFlowList(depends) : null);
  }
  if (content !== file.content) await writeAtomic(join(folder.tasksDir, file.file), content);
}

/** Replaces everything after a task's front matter. */
export async function saveTaskBody(
  folder: RelayFolder,
  taskId: string,
  body: string,
): Promise<void> {
  const file = await taskFile(folder, taskId);
  const eol = file.content.includes('\r\n') ? '\r\n' : '\n';
  const lines = file.content.split(/\r?\n/);
  const close = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  const front = close > 0 ? lines.slice(0, close + 1).join(eol) : `---${eol}id: ${taskId}${eol}---`;
  const next = `${front}${eol}${eol}${body.trim().split(/\r?\n/).join(eol)}${eol}`;
  await writeAtomic(join(folder.tasksDir, file.file), next);
}

const CHECKBOX = /^(\s*[-*+]\s+)\[( |x|X)\]/;

/**
 * Ticks or unticks one acceptance criterion, counted from 0 among the checkboxes under the
 * acceptance heading (or the whole body when it has none), the way the card counts them.
 */
export async function toggleAcceptance(
  folder: RelayFolder,
  taskId: string,
  index: number,
  checked: boolean,
): Promise<void> {
  const file = await taskFile(folder, taskId);
  const eol = file.content.includes('\r\n') ? '\r\n' : '\n';
  const lines = file.content.split(/\r?\n/);
  const close = lines.findIndex((line, at) => at > 0 && /^(---|\.\.\.)\s*$/.test(line));
  const bodyStart = close > 0 ? close + 1 : 0;
  const heading = lines.findIndex(
    (line, at) => at >= bodyStart && /^#{1,4}\s+.*acceptance/i.test(line),
  );
  let from = bodyStart;
  let to = lines.length;
  if (heading !== -1) {
    from = heading + 1;
    const next = lines.findIndex((line, at) => at > heading && /^#{1,4}\s+/.test(line));
    if (next !== -1) to = next;
  }
  let seen = -1;
  for (let at = from; at < to; at += 1) {
    if (!CHECKBOX.test(lines[at])) continue;
    seen += 1;
    if (seen !== index) continue;
    lines[at] = lines[at].replace(CHECKBOX, `$1[${checked ? 'x' : ' '}]`);
    await writeAtomic(join(folder.tasksDir, file.file), lines.join(eol));
    return;
  }
  throw new Error(`${taskId} has no acceptance criterion ${index + 1}.`);
}

/** Adds a task with the next free id. Returns the id. */
export async function createTask(folder: RelayFolder, input: RelayTaskInput): Promise<string> {
  if (!input.title.trim()) throw new Error('A task needs a title.');
  const board = await readBoardFiles(folder);
  const id = nextTaskId(board.files.map((file) => file.task.id));
  const content = renderTaskFile({
    id,
    title: input.title.trim(),
    status: 'todo',
    epic: input.epic ?? null,
    depends: (input.depends ?? []).filter(isRelayTaskId),
    priority: input.priority ?? null,
    size: input.size ?? null,
    milestone: input.milestone ?? null,
    labels: input.labels ?? [],
    agent: input.agent ?? null,
    due: input.due ?? null,
    goal: input.goal,
    scope: input.scope,
    acceptance: input.acceptance,
    testPlan: input.testPlan,
  });
  await writeAtomic(join(folder.tasksDir, taskFileName(id, input.title)), content);
  return id;
}

/** Deletes a task file. Its history stays in git; its handoff and journal stay on disk. */
export async function removeTask(folder: RelayFolder, taskId: string): Promise<void> {
  const file = await taskFile(folder, taskId);
  if (file.task.status === 'in-progress') {
    throw new Error(`${taskId} is being worked on. Stop its session first.`);
  }
  const board = await readBoardFiles(folder);
  const dependents = board.files.filter((entry) => entry.task.depends.includes(taskId));
  if (dependents.length > 0) {
    throw new Error(
      `${dependents.map((entry) => entry.task.id).join(', ')} depend on ${taskId}. Change them first.`,
    );
  }
  await rm(join(folder.tasksDir, file.file), { force: true });
}

/** Writes PLAN.md's settings and sections, creating it when there is none. */
export async function savePlan(folder: RelayFolder, input: RelayPlanInput): Promise<void> {
  const path = planPath(folder);
  const existing = await readFile(path, 'utf-8').catch(() => null);
  if (existing === null) {
    await writeAtomic(
      path,
      renderPlanFile({
        title: input.title ?? 'Plan',
        mode: input.mode,
        budget: input.budget,
        keepRolling: input.keepRolling,
        runPastBudget: input.runPastBudget,
        reviewEachTask: input.reviewEachTask,
        definitionOfDone: input.definitionOfDone,
        goal: input.goal,
        outOfScope: input.outOfScope,
      }),
    );
    return;
  }
  let content = existing;
  const set = (key: string, value: string | null) => {
    content = setFrontMatterValue(content, key, value);
  };
  if (input.title !== undefined) set('title', yamlScalar(input.title.trim() || 'Plan'));
  if (input.mode !== undefined) set('mode', input.mode);
  if (input.budget !== undefined)
    set('budget', input.budget === null ? null : String(input.budget));
  if (input.keepRolling !== undefined) set('keepRolling', String(input.keepRolling));
  if (input.runPastBudget !== undefined) set('runPastBudget', String(input.runPastBudget));
  if (input.reviewEachTask !== undefined) set('reviewEachTask', String(input.reviewEachTask));
  if (input.definitionOfDone !== undefined) {
    set('definitionOfDone', listOrNull(input.definitionOfDone));
  }
  if (input.goal !== undefined) content = setBodySection(content, 'Goal', input.goal);
  if (input.outOfScope !== undefined) {
    content = setBodySection(content, 'Out of scope', input.outOfScope);
  }
  if (content !== existing) await writeAtomic(path, content);
}

const ITEM_FIELDS = [
  'task',
  'owner',
  'target',
  'dependency',
  'ecosystem',
  'waitingFor',
  'revisitBy',
  'likelihood',
  'impact',
] as const;

/** Creates a record (no id) or changes one (with its id). Returns the record's id. */
export async function saveItem(folder: RelayFolder, input: RelayItemInput): Promise<string> {
  const spec = RELAY_ITEM_SPECS[input.kind];
  if (input.status && !spec.statuses.includes(input.status)) {
    throw new Error(`"${input.status}" is not a ${spec.label.toLowerCase()} status.`);
  }
  if (!input.id) {
    if (!input.title?.trim()) throw new Error(`A ${spec.label.toLowerCase()} needs a title.`);
    const id = nextItemId(input.kind, (await itemIds(folder))[input.kind]);
    const content = renderItemFile({
      kind: input.kind,
      id,
      title: input.title.trim(),
      status: input.status,
      created: new Date().toISOString().slice(0, 10),
      ...Object.fromEntries(ITEM_FIELDS.map((field) => [field, input.fields?.[field] ?? null])),
      sections: input.sections,
    });
    await writeItemFile(folder, input.kind, itemFileName(id, input.title), content);
    return id;
  }
  if (!isRelayItemId(input.kind, input.id)) throw new Error(`"${input.id}" is not a record id.`);
  const item = (await readItems(folder, input.kind)).find((entry) => entry.id === input.id);
  if (!item) throw new Error(`There is no ${spec.label.toLowerCase()} ${input.id}.`);
  const path = join(folder.tasksDir, spec.folder, item.file);
  const existing = await readFile(path, 'utf-8');
  let content = existing;
  if (input.title !== undefined) {
    if (!input.title.trim()) throw new Error(`A ${spec.label.toLowerCase()} needs a title.`);
    content = setFrontMatterValue(content, 'title', yamlScalar(input.title.trim()));
  }
  if (input.status) content = setFrontMatterValue(content, 'status', input.status);
  for (const field of ITEM_FIELDS) {
    const value = input.fields?.[field];
    if (value !== undefined) content = setFrontMatterValue(content, field, scalarOrNull(value));
  }
  for (const [heading, text] of Object.entries(input.sections ?? {})) {
    content = setBodySection(content, heading, text);
  }
  if (content !== existing) await writeAtomic(path, content);
  return input.id;
}

export async function removeItem(
  folder: RelayFolder,
  kind: RelayItemKind,
  id: string,
): Promise<void> {
  if (!isRelayItemId(kind, id)) throw new Error(`"${id}" is not a record id.`);
  const item = (await readItems(folder, kind)).find((entry) => entry.id === id);
  if (!item) return;
  await rm(join(folder.tasksDir, RELAY_ITEM_SPECS[kind].folder, item.file), { force: true });
}

/** A task's journal entries, oldest first. */
export async function journalEntries(folder: RelayFolder, taskId: string) {
  const text = await readJournal(folder, taskId);
  return text ? parseJournal(text) : [];
}

/** Makes a task that takes a workaround out, and returns its id. */
export async function taskForWorkaround(folder: RelayFolder, id: string): Promise<string> {
  if (!isRelayItemId('workaround', id)) throw new Error(`"${id}" is not a workaround id.`);
  const item = (await readItems(folder, 'workaround')).find((entry) => entry.id === id);
  if (!item) throw new Error(`There is no workaround ${id}.`);
  const draft = taskFromWorkaround(item);
  return createTask(folder, { ...draft, labels: ['workaround'] });
}

/** The front matter and body of PLAN.md as text, for the editor. */
export async function planBody(folder: RelayFolder): Promise<string | null> {
  const text = await readFile(planPath(folder), 'utf-8').catch(() => null);
  return text === null ? null : splitFrontMatter(text).body;
}
