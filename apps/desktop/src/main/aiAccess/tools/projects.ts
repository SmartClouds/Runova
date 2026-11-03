import { z } from 'zod';
import { updateProjectRecord } from '../../ipc/projects';
import { store } from '../../store';
import { defineTool } from '../registry';
import { projectIdArg, projectOf } from './shared';

/** Project tools: find a project, read what Runova knows about it, and keep its notes. */

export const projectTools = [
  defineTool({
    name: 'projects_list',
    area: 'projects',
    title: 'List projects',
    description:
      'Every project in Runova with its id, name and folder. Other tools take the id as projectId.',
    risk: 'read',
    input: z.object({
      includeArchived: z.boolean().optional().describe('Also list archived projects.'),
    }),
    preview: () => ({ title: 'List your projects' }),
    async run(args) {
      const projects = await store.getProjects();
      return {
        data: projects
          .filter((project) => args.includeArchived || !project.archived)
          .map((project) => ({
            id: project.id,
            name: project.name,
            folder: project.folderPath,
            description: project.description ?? '',
            tags: project.tags ?? [],
            pinned: project.pinned === true,
            archived: project.archived === true,
          })),
      };
    },
  }),

  defineTool({
    name: 'projects_get',
    area: 'projects',
    title: 'Get project details',
    description:
      "One project's details: folder, description, notes, run commands, repository and website.",
    risk: 'read',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    preview: () => ({ title: 'Read the project details' }),
    async run(_args, context) {
      const project = await projectOf(context);
      return {
        data: {
          id: project.id,
          name: project.name,
          folder: project.folderPath,
          description: project.description ?? '',
          tags: project.tags ?? [],
          notes: project.notes ?? '',
          cli: project.cliId ?? null,
          runCommands: (project.runCommands ?? []).map((command) => ({
            label: command.label,
            command: command.command,
          })),
          repoUrl: project.repoUrl ?? null,
          websiteUrl: project.websiteUrl ?? null,
        },
      };
    },
  }),

  defineTool({
    name: 'project_update_notes',
    area: 'projects',
    title: 'Update project notes',
    description:
      "Replaces the project's notes, or adds to the end of them with mode append. Notes are what the user keeps on the project page.",
    risk: 'write',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      notes: z.string().max(100_000),
      mode: z.enum(['replace', 'append']).optional(),
    }),
    async preview(args, context) {
      const project = await projectOf(context);
      const before = project.notes ?? '';
      return {
        title: `${args.mode === 'append' ? 'Add to' : 'Replace'} the notes of ${project.name}`,
        diff: { fileName: 'Notes', before, after: nextNotes(before, args.notes, args.mode) },
      };
    },
    async run(args, context) {
      const project = await projectOf(context);
      await updateProjectRecord(project.id, {
        notes: nextNotes(project.notes ?? '', args.notes, args.mode),
      });
      return { text: `Updated the notes of ${project.name}.` };
    },
  }),
];

function nextNotes(before: string, notes: string, mode: 'replace' | 'append' | undefined): string {
  if (mode !== 'append' || !before.trim()) return notes;
  return `${before.replace(/\s+$/, '')}\n\n${notes}`;
}
