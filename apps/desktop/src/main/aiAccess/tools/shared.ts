import type { Project } from '@runova/core';
import { z } from 'zod';
import { store } from '../../store';
import type { ToolContext } from '../registry';

/** Pieces every tool pack uses: the optional project argument and finding that project. */

export const projectIdArg = z
  .string()
  .optional()
  .describe(
    'The project to work on, from projects_list. Leave it out to use the project the agent runs in.',
  );

/** The project a call works on. The server has already refused a call that needs one and has none. */
export function projectIdOf(context: ToolContext): string {
  if (!context.projectId) throw new Error('Pass projectId; projects_list gives the ids.');
  return context.projectId;
}

export async function projectOf(context: ToolContext): Promise<Project> {
  const id = projectIdOf(context);
  const project = (await store.getProjects()).find((one) => one.id === id);
  if (!project) throw new Error(`Runova has no project with the id ${id}.`);
  return project;
}

/** "3 keys", "1 key". */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
