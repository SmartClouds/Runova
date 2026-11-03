import { z } from 'zod';
import { getHealthScheduler } from '../../health/scheduler';
import { broadcastHealthChanged, mutateHealth, readHealthState } from '../../health/store';
import { defineTool } from '../registry';
import { projectIdArg } from './shared';

/**
 * Healthcheck tools: what the Monitoring view shows about a project's healthchecks, a check on
 * demand, and pausing one. Adding or removing healthchecks, and their secrets, stay in the app.
 */

const targetArg = z
  .string()
  .min(1)
  .describe('The healthcheck, by name or id. health_list lists them.');

async function findTarget(ref: string, projectId: string | null) {
  const { targets, results } = await readHealthState();
  const scoped = targets.filter((one) => !projectId || one.projectId === projectId);
  const target =
    scoped.find((one) => one.id === ref) ??
    scoped.find((one) => one.name.toLowerCase() === ref.trim().toLowerCase());
  if (!target) throw new Error(`No healthcheck named ${ref}. health_list lists them.`);
  return { target, result: results[target.id] };
}

function stateOf(result: Awaited<ReturnType<typeof findTarget>>['result']) {
  return {
    state: result?.track.confirmed ?? 'unknown',
    lastCheckedAt: result?.lastCheckedAt ? new Date(result.lastCheckedAt).toISOString() : null,
    lastSample: result?.samples.at(-1) ?? null,
    openIncidents: (result?.incidents ?? []).filter((one) => !one.resolvedAt).length,
  };
}

export const healthTools = [
  defineTool({
    name: 'health_list',
    area: 'health',
    title: 'List healthchecks',
    description:
      "Healthchecks with their address, whether they are paused, and how the last check went. Leave projectId out for the project in use; pass all: true for every project's.",
    risk: 'read',
    input: z.object({ projectId: projectIdArg, all: z.boolean().optional() }),
    preview: () => ({ title: 'List the healthchecks' }),
    async run(args, context) {
      const { targets, results } = await readHealthState();
      return {
        data: targets
          .filter((one) => args.all || !context.projectId || one.projectId === context.projectId)
          .map((target) => ({
            id: target.id,
            name: target.name,
            url: target.url,
            paused: target.paused,
            intervalSec: target.intervalSec,
            ...stateOf(results[target.id]),
          })),
      };
    },
  }),

  defineTool({
    name: 'health_check_now',
    area: 'health',
    title: 'Run a healthcheck now',
    description:
      'Checks a target right away instead of at its next interval, and returns the result.',
    risk: 'write',
    input: z.object({ projectId: projectIdArg, target: targetArg }),
    preview: (args) => ({ title: `Check ${args.target} now` }),
    async run(args, context) {
      const { target } = await findTarget(args.target, context.projectId);
      await getHealthScheduler().checkNow(target.id);
      const { result } = await findTarget(target.id, null);
      return { data: { name: target.name, url: target.url, ...stateOf(result) } };
    },
  }),

  defineTool({
    name: 'health_pause',
    area: 'health',
    title: 'Pause or resume a healthcheck',
    description: 'Pauses a healthcheck, or resumes it with paused: false.',
    risk: 'write',
    input: z.object({ projectId: projectIdArg, target: targetArg, paused: z.boolean() }),
    preview: (args) => ({
      title: `${args.paused ? 'Pause' : 'Resume'} the ${args.target} healthcheck`,
    }),
    async run(args, context) {
      const { target } = await findTarget(args.target, context.projectId);
      await mutateHealth((state) => {
        const stored = state.targets.find((one) => one.id === target.id);
        if (!stored) throw new Error('That healthcheck no longer exists.');
        stored.paused = args.paused;
        stored.updatedAt = Date.now();
        const result = state.results[stored.id];
        if (!args.paused && result) result.nextCheckAt = null;
      });
      broadcastHealthChanged([target.id]);
      return { text: `${args.paused ? 'Paused' : 'Resumed'} ${target.name}.` };
    },
  }),
];
