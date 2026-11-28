import { join } from 'node:path';
import { setFrontMatterValue, setTaskStatus, yamlScalar } from '@runova/core';
import type { RelayRedoInput, RelayRedoResult } from '../../shared/relayTypes';
import { archiveAttempt } from './planFiles';
import { type RelayFolder, readBoardFiles, writeAtomic } from './taskFiles';

/**
 * Redo with another agent (E121). Each task's handoff and journal move into the archive as the
 * attempt that is ending, its attempt number goes up, it goes back to todo, and it gets the CLI
 * asked for. With `keepLearnings` the task names the archived attempt under `learnFrom`, so the
 * next session reads it; without, it starts from the spec alone. Done tasks are redone only when
 * named; `all` takes every task that is not done.
 */
export async function redoTasks(
  folder: RelayFolder,
  input: Pick<RelayRedoInput, 'taskIds' | 'agent' | 'keepLearnings'>,
): Promise<Pick<RelayRedoResult, 'redone' | 'warnings'>> {
  const board = await readBoardFiles(folder);
  const byId = new Map(board.files.map((file) => [file.task.id, file]));
  const warnings: string[] = [];
  const wanted =
    input.taskIds === 'all'
      ? board.files.filter((file) => file.task.status !== 'done').map((file) => file.task.id)
      : input.taskIds;
  const redone: string[] = [];
  for (const taskId of wanted) {
    const file = byId.get(taskId);
    if (!file) {
      warnings.push(`${taskId} is not on the board, so it was not redone.`);
      continue;
    }
    if (file.task.status === 'in-progress') {
      warnings.push(`${taskId} is being worked on. Stop its session first, then redo it.`);
      continue;
    }
    const attempt = file.task.attempt ?? 1;
    const archived = await archiveAttempt(folder, taskId, attempt, file.task.agent);
    let content = setTaskStatus(file.content, 'todo');
    content = setFrontMatterValue(content, 'attempt', String(attempt + 1));
    content = setFrontMatterValue(content, 'started', null);
    content = setFrontMatterValue(content, 'finished', null);
    content = setFrontMatterValue(
      content,
      'learnFrom',
      input.keepLearnings && archived ? String(attempt) : null,
    );
    if (input.agent) content = setFrontMatterValue(content, 'agent', yamlScalar(input.agent));
    // A finished task's criteria start unticked again: the new attempt has to meet them.
    content = content.replace(/^(\s*[-*+]\s+)\[[xX]\]/gm, '$1[ ]');
    await writeAtomic(join(folder.tasksDir, file.file), content);
    redone.push(taskId);
  }
  return { redone, warnings };
}
