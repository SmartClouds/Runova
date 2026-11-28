import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendJournalEntry,
  archiveRelPath,
  isRelayItemId,
  isRelayTaskId,
  itemIdFromFileName,
  parseItemFile,
  parsePlanFile,
  RELAY_ARCHIVE_DIR,
  RELAY_ITEM_KINDS,
  RELAY_ITEM_SPECS,
  RELAY_JOURNAL_DIR,
  RELAY_PLAN_FILE,
  type RelayItem,
  type RelayItemKind,
  type RelayJournalEntry,
  type RelayPlan,
  renderAttemptArchive,
  setFrontMatterValue,
} from '@runova/core';
import { exists, type RelayFolder, writeAtomic } from './taskFiles';

/**
 * The plan pack's files inside a project (E121): PLAN.md, one folder per kind of record, the
 * journals and the archive of redone attempts. Every name written here is built from an id that
 * was checked against its pattern, so nothing lands outside the tasks folder.
 */

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

export function planPath(folder: RelayFolder): string {
  return join(folder.tasksDir, RELAY_PLAN_FILE);
}

export async function readPlan(folder: RelayFolder): Promise<RelayPlan | null> {
  const text = await readText(planPath(folder));
  return text === null ? null : parsePlanFile(text);
}

/**
 * Writes PLAN.md when the project has none. When it has one, only its mode changes (if a mode is
 * given), so a plan a person wrote keeps everything else. Returns what happened.
 */
export async function writePlan(
  folder: RelayFolder,
  content: string | null,
  mode?: 'fit' | 'plan',
): Promise<'written' | 'updated' | 'kept' | 'none'> {
  const path = planPath(folder);
  const existing = await readText(path);
  if (existing === null) {
    if (content === null) return 'none';
    await mkdir(folder.tasksDir, { recursive: true });
    await writeAtomic(path, content);
    return 'written';
  }
  if (!mode || parsePlanFile(existing).mode === mode) return 'kept';
  let next = setFrontMatterValue(existing, 'mode', mode, { after: 'title' });
  if (mode === 'plan') {
    next = setFrontMatterValue(next, 'keepRolling', 'true');
    next = setFrontMatterValue(next, 'runPastBudget', 'true');
  }
  await writeAtomic(path, next);
  return 'updated';
}

function itemDir(folder: RelayFolder, kind: RelayItemKind): string {
  return join(folder.tasksDir, RELAY_ITEM_SPECS[kind].folder);
}

/** Every record of one kind, ordered by id. A file that will not read is skipped. */
export async function readItems(folder: RelayFolder, kind: RelayItemKind): Promise<RelayItem[]> {
  let names: string[];
  try {
    names = await readdir(itemDir(folder, kind));
  } catch {
    return [];
  }
  const items: RelayItem[] = [];
  const seen = new Set<string>();
  for (const name of names.sort()) {
    if (!itemIdFromFileName(kind, name)) continue;
    const text = await readText(join(itemDir(folder, kind), name));
    if (text === null) continue;
    const item = parseItemFile(kind, name, text);
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

export async function readAllItems(
  folder: RelayFolder,
): Promise<Record<RelayItemKind, RelayItem[]>> {
  const entries = await Promise.all(
    RELAY_ITEM_KINDS.map(async (kind) => [kind, await readItems(folder, kind)] as const),
  );
  return Object.fromEntries(entries) as Record<RelayItemKind, RelayItem[]>;
}

/** The ids in use per kind, by file name, so new records continue the numbering. */
export async function itemIds(folder: RelayFolder): Promise<Record<RelayItemKind, string[]>> {
  const entries = await Promise.all(
    RELAY_ITEM_KINDS.map(async (kind) => {
      const names = await readdir(itemDir(folder, kind)).catch(() => [] as string[]);
      const ids = names
        .map((name) => itemIdFromFileName(kind, name))
        .filter((id): id is string => id !== null);
      return [kind, ids] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<RelayItemKind, string[]>;
}

/** Writes a record file under its kind's folder. The name must start with a valid id. */
export async function writeItemFile(
  folder: RelayFolder,
  kind: RelayItemKind,
  file: string,
  content: string,
): Promise<boolean> {
  const id = itemIdFromFileName(kind, file);
  if (!id || !isRelayItemId(kind, id) || /[/\\]/.test(file)) return false;
  await mkdir(itemDir(folder, kind), { recursive: true });
  await writeAtomic(join(itemDir(folder, kind), file), content);
  return true;
}

/** Whether earlier tasks left decisions or workarounds a session should look at. */
export async function hasRecords(folder: RelayFolder): Promise<boolean> {
  for (const kind of ['decision', 'workaround'] as const) {
    const names = await readdir(itemDir(folder, kind)).catch(() => [] as string[]);
    if (names.some((name) => itemIdFromFileName(kind, name))) return true;
  }
  return false;
}

function journalPath(folder: RelayFolder, taskId: string): string {
  return join(folder.tasksDir, RELAY_JOURNAL_DIR, `${taskId}.md`);
}

export async function readJournal(folder: RelayFolder, taskId: string): Promise<string | null> {
  if (!isRelayTaskId(taskId)) return null;
  return readText(journalPath(folder, taskId));
}

/** Adds one session to a task's journal, creating the journal on the first. */
export async function appendJournal(
  folder: RelayFolder,
  taskId: string,
  entry: RelayJournalEntry,
): Promise<void> {
  if (!isRelayTaskId(taskId)) return;
  const path = journalPath(folder, taskId);
  const existing = await readText(path);
  await mkdir(join(folder.tasksDir, RELAY_JOURNAL_DIR), { recursive: true });
  await writeAtomic(path, appendJournalEntry(existing, taskId, entry));
}

function archivePath(folder: RelayFolder, taskId: string, attempt: number): string {
  return join(folder.handoffsDir, RELAY_ARCHIVE_DIR, `${taskId}-attempt-${attempt}.md`);
}

/**
 * Moves a task's handoff and journal into one archive file for the attempt that is ending, so the
 * next attempt starts clean. Returns false when there was nothing to archive.
 */
export async function archiveAttempt(
  folder: RelayFolder,
  taskId: string,
  attempt: number,
  agent: string | null,
): Promise<boolean> {
  if (!isRelayTaskId(taskId)) return false;
  const handoffFile = join(folder.handoffsDir, `${taskId}.md`);
  const [handoff, journal] = await Promise.all([
    readText(handoffFile),
    readText(journalPath(folder, taskId)),
  ]);
  if (handoff === null && journal === null) return false;
  const target = archivePath(folder, taskId, attempt);
  if (await exists(target)) return false;
  await mkdir(join(folder.handoffsDir, RELAY_ARCHIVE_DIR), { recursive: true });
  await writeAtomic(target, renderAttemptArchive({ taskId, attempt, handoff, journal, agent }));
  await rm(handoffFile, { force: true });
  await rm(journalPath(folder, taskId), { force: true });
  return true;
}

/** Whether a task has an archived attempt with that number. */
export function attemptArchived(
  folder: RelayFolder,
  taskId: string,
  attempt: number,
): Promise<boolean> {
  return exists(archivePath(folder, taskId, attempt));
}

/** What a session's prompt points at besides its task: the plan, the records, an earlier attempt. */
export async function legPointers(
  folder: RelayFolder,
  task: { id: string; learnFrom: number | null },
): Promise<{ hasPlan: boolean; hasRecords: boolean; previousAttempt: string | null }> {
  const [plan, records, archived] = await Promise.all([
    exists(planPath(folder)),
    hasRecords(folder),
    task.learnFrom ? attemptArchived(folder, task.id, task.learnFrom) : Promise.resolve(false),
  ]);
  return {
    hasPlan: plan,
    hasRecords: records,
    previousAttempt:
      archived && task.learnFrom
        ? archiveRelPath(folder.docsFolder, task.id, task.learnFrom)
        : null,
  };
}
