import { z } from 'zod';
import type { RelayRunView } from '../../../shared/relayTypes';
import { buildRelayBoard, relayTaskDetail } from '../../relay/board';
import { defineTool } from '../registry';
import { projectIdArg, projectIdOf } from './shared';

/**
 * Relay tools: a project's relay board as the Relay page shows it, with the relay running on it
 * and its current leg, and one task in full with its handoff and the sessions run on it. They only
 * read. Starting, pausing and cancelling a relay stay with the user in the app.
 */

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

function shapeRun(run: RelayRunView) {
  const leg = run.current;
  return {
    id: run.id,
    status: run.status,
    trigger: run.triggerText,
    queue: run.queue,
    finished: run.finished,
    pauseReason: run.pauseReason,
    startedAt: iso(run.createdAt),
    currentLeg: leg
      ? {
          taskId: leg.taskId,
          legNo: leg.legNo,
          phase: leg.phase,
          cliId: leg.choice.cliId,
          model: leg.choice.model ?? null,
          startedAt: iso(leg.startedAt),
          contextTokens: leg.contextTokens,
          peakContextTokens: leg.peakContextTokens,
          budget: leg.budget,
          waitingFor: leg.awaiting?.message ?? null,
        }
      : null,
  };
}

export const relayTools = [
  defineTool({
    name: 'relay_board',
    area: 'relay',
    title: 'Show the relay board',
    description:
      "The project's relay tasks in run order with their status, dependencies, acceptance progress and last handoff, plus the relay running on the project (if any) with its current leg and context use.",
    risk: 'read',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    preview: () => ({ title: 'Show the relay board' }),
    async run(_args, context) {
      const board = await buildRelayBoard(projectIdOf(context));
      const byId = new Map(board.tasks.map((task) => [task.id, task]));
      const ordered = [
        ...board.order.flatMap((id) => byId.get(id) ?? []),
        ...board.tasks.filter((task) => !board.order.includes(task.id)),
      ];
      return {
        data: {
          docsFolder: board.docsFolder,
          exists: board.exists,
          tasks: ordered.map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            epic: task.epic,
            depends: task.depends,
            acceptance: `${task.acceptance.checked}/${task.acceptance.total}`,
            sessions: task.legCount,
            file: task.file,
            handoff: task.handoff
              ? {
                  outcome: task.handoff.outcome,
                  tests: task.handoff.tests,
                  updated: task.handoff.updated,
                  next: task.handoff.next,
                }
              : null,
          })),
          problems: [
            ...board.issues.map((issue) => issue.message),
            ...board.cycles.map(
              (cycle) => `These tasks depend on each other: ${cycle.join(', ')}.`,
            ),
            ...board.missing.map(
              (gap) => `${gap.taskId} depends on ${gap.dependsOn}, which is not on the board.`,
            ),
          ],
          relay: board.active ? shapeRun(board.active) : null,
        },
      };
    },
  }),

  defineTool({
    name: 'relay_task',
    area: 'relay',
    title: 'Read a relay task',
    description:
      'One relay task in full: its file, its latest handoff, and every session run on it with the CLI, result and context used.',
    risk: 'read',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      taskId: z
        .string()
        .regex(/^T\d{3,}$/, 'A task id looks like T001.')
        .describe('The task id, like T004. relay_board lists them.'),
    }),
    preview: (args) => ({ title: `Read the relay task ${args.taskId}` }),
    async run(args, context) {
      const detail = await relayTaskDetail(projectIdOf(context), args.taskId);
      if (!detail) throw new Error(`The relay board has no task ${args.taskId}.`);
      const { task } = detail;
      return {
        data: {
          id: task.id,
          title: task.title,
          status: task.status,
          depends: task.depends,
          file: task.file,
          acceptance: `${task.acceptance.checked}/${task.acceptance.total}`,
          body: task.body,
          handoff: detail.handoffText,
          legs: detail.legs.map((leg) => ({
            legNo: leg.legNo,
            cliId: leg.cliId,
            model: leg.model,
            startedAt: iso(leg.startedAt),
            endedAt: iso(leg.endedAt),
            result: leg.result,
            outcome: leg.outcome,
            tests: leg.tests,
            peakContextTokens: leg.peakContextTokens,
          })),
        },
      };
    },
  }),
];
