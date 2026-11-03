import {
  BLUEPRINT_STEP_IDS,
  type BlueprintStepId,
  blueprintStep,
  createBlankBlueprint,
  DEFAULT_TARGET_AI,
  type ProjectBlueprint,
  type PromptTemplate,
} from '@runova/core';
import { z } from 'zod';
import { updateBlueprintSection } from '../../ipc/blueprints';
import { deleteTemplate, saveTemplate } from '../../ipc/templates';
import { promptHistoryDb } from '../../promptHistoryDb';
import { store } from '../../store';
import { defineTool, type ToolContext } from '../registry';
import { projectIdArg, projectIdOf } from './shared';

/**
 * Prompt tools: the templates saved in the Prompt Builder, the steps of a project's blueprint
 * (the stepped description behind its Product Manager prompt), and the prompt history. Saves go
 * through the same functions the Prompt Builder and the Blueprint tab call.
 */

const templateArg = z
  .string()
  .min(1)
  .describe('The template, by name (any case) or id. prompts_list lists them.');

async function findTemplate(ref: string): Promise<PromptTemplate> {
  const templates = await store.getTemplates();
  const byId = templates.find((one) => one.id === ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  const named = templates.filter((one) => one.name.trim().toLowerCase() === wanted);
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    throw new Error(
      `${named.length} templates are named ${ref}. Pass the id instead: ${named.map((one) => one.id).join(', ')}.`,
    );
  }
  const names = templates.map((one) => one.name).join(', ');
  throw new Error(
    `No prompt template named ${ref}. ${names ? `There are: ${names}.` : 'None are saved yet.'}`,
  );
}

/** The project's blueprint as stored, or a blank one when the tab was never opened. Never saves. */
async function readBlueprint(projectId: string): Promise<ProjectBlueprint> {
  const stored = (await store.getBlueprints()).find((one) => one.projectId === projectId);
  return stored ?? createBlankBlueprint('', projectId);
}

function stepText(blueprint: ProjectBlueprint, stepId: BlueprintStepId): string {
  return blueprint.sections.find((one) => one.stepId === stepId)?.text ?? '';
}

async function projectExists(context: ToolContext): Promise<string> {
  const projectId = projectIdOf(context);
  if (!(await store.getProjects()).some((one) => one.id === projectId)) {
    throw new Error(`Runova has no project with the id ${projectId}.`);
  }
  return projectId;
}

export const promptTools = [
  defineTool({
    name: 'prompts_list',
    area: 'prompts',
    title: 'List prompt templates',
    description:
      'The prompt templates saved in the Prompt Builder, newest first, each with its name, prompt type, target AI and full text.',
    risk: 'read',
    input: z.object({}),
    preview: () => ({ title: 'Read your prompt templates' }),
    async run() {
      const templates = await store.getTemplates();
      return {
        data: templates.map((one) => ({
          id: one.id,
          name: one.name,
          promptType: one.promptType,
          targetAI: one.targetAI,
          content: one.content,
          createdAt: one.createdAt,
        })),
      };
    },
  }),

  defineTool({
    name: 'prompts_save',
    area: 'prompts',
    title: 'Save a prompt template',
    description:
      'Saves a new prompt template to the Prompt Builder library, at the top of the list. It does not replace a template with the same name.',
    risk: 'write',
    input: z.object({
      name: z.string().trim().min(1).max(200),
      content: z.string().min(1).describe('The prompt text.'),
      promptType: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('A Prompt Builder type, like Frontend, Backend, Full Stack or Testing.'),
      targetAI: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('The agent the prompt is written for, like Claude Code or Codex.'),
    }),
    preview: (args) => ({
      title: `Save the prompt template ${args.name}`,
      diff: { fileName: args.name, before: '', after: args.content },
    }),
    async run(args) {
      const saved = await saveTemplate({
        name: args.name,
        content: args.content,
        promptType: args.promptType ?? 'Full Stack',
        targetAI: args.targetAI ?? DEFAULT_TARGET_AI,
      });
      return { data: { id: saved.id, name: saved.name } };
    },
  }),

  defineTool({
    name: 'prompts_remove',
    area: 'prompts',
    title: 'Remove a prompt template',
    description: 'Deletes a saved prompt template from the Prompt Builder library.',
    risk: 'sensitive',
    input: z.object({ template: templateArg }),
    async preview(args) {
      const found = await findTemplate(args.template);
      return {
        title: `Remove the prompt template ${found.name}`,
        diff: { fileName: found.name, before: found.content, after: '' },
      };
    },
    async run(args) {
      const found = await findTemplate(args.template);
      await deleteTemplate(found.id);
      return { text: `Removed the prompt template ${found.name}.` };
    },
  }),

  defineTool({
    name: 'prompts_blueprint',
    area: 'prompts',
    title: 'Read the project blueprint',
    description:
      "The project's blueprint: the text of each step (idea, architecture, backend, frontend, cicd, quality), whether it goes into the agent instruction file, and the generated Product Manager prompt.",
    risk: 'read',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    preview: () => ({ title: 'Read the project blueprint' }),
    async run(_args, context) {
      const blueprint = await readBlueprint(await projectExists(context));
      return {
        data: {
          docsFolder: blueprint.docsFolder,
          steps: blueprint.sections.map((section) => ({
            step: section.stepId,
            label: blueprintStep(section.stepId).label,
            text: section.text,
            includeInAgentFile: section.includeInAgentFile,
            attachments: section.attachments.map((one) => one.displayName),
          })),
          finalPrompt: blueprint.finalPrompt,
          finalPromptUpdatedAt: blueprint.finalPromptUpdatedAt,
        },
      };
    },
  }),

  defineTool({
    name: 'prompts_blueprint_update',
    area: 'prompts',
    title: 'Edit a blueprint step',
    description:
      "Replaces the text of one step of the project's blueprint. The old text stays in the step's history.",
    risk: 'write',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      step: z.enum(BLUEPRINT_STEP_IDS),
      text: z.string().describe('The full new text of the step, in markdown.'),
    }),
    async preview(args, context) {
      const blueprint = await readBlueprint(projectIdOf(context));
      const label = blueprintStep(args.step).label;
      return {
        title: `Edit the ${label} step of the blueprint`,
        diff: {
          fileName: `Blueprint: ${label}`,
          before: stepText(blueprint, args.step),
          after: args.text,
        },
      };
    },
    async run(args, context) {
      const projectId = await projectExists(context);
      await updateBlueprintSection(projectId, args.step, { text: args.text });
      return { text: `Saved the ${blueprintStep(args.step).label} step of the blueprint.` };
    },
  }),

  defineTool({
    name: 'prompts_history',
    area: 'prompts',
    title: 'Prompt history',
    description:
      'Prompts the Prompt Builder generated or translated, newest first, with what was asked for and the prompt it produced. Can search by a word and keep to the current project.',
    risk: 'read',
    input: z.object({
      projectId: projectIdArg,
      search: z.string().trim().min(1).optional().describe('Only prompts containing this text.'),
      onlyThisProject: z
        .boolean()
        .optional()
        .describe('Only prompts made for the project. By default every prompt is included.'),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    preview: () => ({ title: 'Read your prompt history' }),
    async run(args, context) {
      const projectId = args.onlyThisProject ? projectIdOf(context) : null;
      const entries = args.search
        ? promptHistoryDb.search(args.search, projectId, args.limit)
        : promptHistoryDb.list(projectId, args.limit);
      return {
        data: entries.map((one) => ({
          id: one.id,
          request: one.rawInput,
          prompt: one.content,
          promptType: one.promptType,
          targetAI: one.targetAI,
          source: one.source,
          tags: one.tags,
          projectId: one.projectId,
          createdAt: one.createdAt,
        })),
      };
    },
  }),
];
