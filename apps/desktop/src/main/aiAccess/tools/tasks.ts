import { z } from 'zod';
import { createScheduledTasks, updateScheduledTask } from '../../ipc/scheduledTasks';
import { store } from '../../store';
import { defineTool, type ToolContext } from '../registry';
import { projectIdArg, projectIdOf } from './shared';

/**
 * Scheduled task tools: the prompts a project has queued for later, as the Prompts tab shows them.
 * A task that waits for Run now is an ordinary change; one that starts an agent by itself at its
 * time is sensitive, so it has a tool of its own.
 */

const runAtArg = z.iso
  .datetime({ offset: true })
  .describe('When, as an ISO date and time with a zone.');

async function findTask(context: ToolContext, taskId: string) {
  const task = (await store.getScheduledTasks()).find(
    (one) => one.id === taskId && one.projectId === projectIdOf(context),
  );
  if (!task) throw new Error('This project has no task with that id. tasks_list lists them.');
  return task;
}

function schedule(runMode: 'manual' | 'auto') {
  return async (
    args: { prompt: string; runAt: string; cliId?: string; model?: string },
    context: ToolContext,
  ) => {
    const [task] = await createScheduledTasks(projectIdOf(context), [
      {
        rawInput: args.prompt,
        promptType: 'custom',
        targetAI: 'Claude Code',
        content: args.prompt,
        runAt: new Date(args.runAt).toISOString(),
        runMode,
        cliId: args.cliId,
        model: args.model,
      },
    ]);
    return { text: `Scheduled for ${task.runAt} (id ${task.id}).` };
  };
}

const scheduleInput = z.object({
  projectId: projectIdArg,
  prompt: z.string().min(1).max(50_000),
  runAt: runAtArg,
  cliId: z
    .string()
    .optional()
    .describe('The CLI to run it in, like claude-code. Defaults to the default CLI.'),
  model: z.string().optional(),
});

export const taskTools = [
  defineTool({
    name: 'tasks_list',
    area: 'scheduledTasks',
    title: 'List scheduled tasks',
    description:
      "The project's scheduled prompts with their time, status and whether they start by themselves.",
    risk: 'read',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    preview: () => ({ title: 'List the scheduled tasks' }),
    async run(_args, context) {
      const tasks = (await store.getScheduledTasks()).filter(
        (task) => task.projectId === projectIdOf(context),
      );
      return {
        data: tasks.map((task) => ({
          id: task.id,
          runAt: task.runAt,
          status: task.status,
          startsByItself: task.runMode === 'auto',
          cli: task.cliId ?? null,
          prompt: task.content,
        })),
      };
    },
  }),

  defineTool({
    name: 'task_schedule',
    area: 'scheduledTasks',
    title: 'Schedule a prompt',
    description: 'Queues a prompt for later. At its time it waits for the user to press Run now.',
    risk: 'write',
    needsProject: true,
    input: scheduleInput,
    preview: (args) => ({
      title: 'Schedule a prompt',
      fields: [
        { label: 'When', value: new Date(args.runAt).toLocaleString() },
        { label: 'Prompt', value: args.prompt },
      ],
    }),
    run: schedule('manual'),
  }),

  defineTool({
    name: 'task_schedule_run',
    area: 'scheduledTasks',
    title: 'Schedule a prompt that runs by itself',
    description:
      'Queues a prompt that opens an agent in a terminal and starts by itself at its time, while Runova is open.',
    risk: 'sensitive',
    needsProject: true,
    input: scheduleInput,
    preview: (args) => ({
      title: 'Schedule a prompt that starts an agent by itself',
      summary: 'At this time an agent starts on this prompt without asking you.',
      fields: [
        { label: 'When', value: new Date(args.runAt).toLocaleString() },
        { label: 'CLI', value: args.cliId ?? 'The default CLI' },
        { label: 'Prompt', value: args.prompt },
      ],
    }),
    run: schedule('auto'),
  }),

  defineTool({
    name: 'task_update',
    area: 'scheduledTasks',
    title: 'Change a scheduled task',
    description:
      'Moves a task to another time, changes its prompt, or cancels it with cancel: true.',
    risk: 'write',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      taskId: z.string().min(1),
      runAt: runAtArg.optional(),
      prompt: z.string().min(1).max(50_000).optional(),
      cancel: z.boolean().optional(),
    }),
    preview: (args) => ({
      title: args.cancel ? 'Cancel a scheduled task' : 'Change a scheduled task',
    }),
    async run(args, context) {
      await findTask(context, args.taskId);
      const updated = await updateScheduledTask(args.taskId, {
        ...(args.runAt ? { runAt: new Date(args.runAt).toISOString() } : {}),
        ...(args.prompt ? { content: args.prompt, rawInput: args.prompt } : {}),
        ...(args.cancel ? { status: 'cancelled' as const } : {}),
      });
      return {
        text: `Updated the task; it is ${updated?.status ?? 'gone'}, at ${updated?.runAt ?? ''}.`,
      };
    },
  }),

  defineTool({
    name: 'task_remove',
    area: 'scheduledTasks',
    title: 'Delete a scheduled task',
    description: 'Deletes a scheduled task.',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({ projectId: projectIdArg, taskId: z.string().min(1) }),
    async preview(args, context) {
      const task = await findTask(context, args.taskId);
      return {
        title: 'Delete a scheduled task',
        fields: [{ label: 'Prompt', value: task.content }],
      };
    },
    async run(args, context) {
      await findTask(context, args.taskId);
      const tasks = await store.getScheduledTasks();
      await store.setScheduledTasks(tasks.filter((task) => task.id !== args.taskId));
      return { text: 'Deleted the task.' };
    },
  }),
];
