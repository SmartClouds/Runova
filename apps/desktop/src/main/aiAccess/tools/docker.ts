import { z } from 'zod';
import type { DockerContainer } from '../../../shared/apiTypes';
import {
  isDockerAvailable,
  listContainers,
  listContainersForProject,
  readContainerLogs,
  removeContainer,
  restartContainer,
  startContainer,
  stopContainer,
} from '../../docker/dockerCli';
import { defineTool, type ToolContext } from '../registry';
import { projectIdArg, projectOf } from './shared';

/**
 * Docker tools: the containers on this computer, as the Docker page shows them. A container is
 * found by name or id; starting one is an ordinary change, while stopping, restarting or removing
 * one interrupts whatever runs in it, so those are sensitive.
 */

const containerArg = z
  .string()
  .min(1)
  .describe('The container, by name or id. docker_list lists them.');

async function requireDocker(): Promise<void> {
  if (!(await isDockerAvailable())) throw new Error('Docker is not running on this computer.');
}

async function findContainer(ref: string): Promise<DockerContainer> {
  await requireDocker();
  const all = await listContainers();
  const found =
    all.find((one) => one.id === ref || one.id.startsWith(ref)) ??
    all.find((one) => one.name === ref || one.name.toLowerCase() === ref.toLowerCase());
  if (!found) throw new Error(`No container named ${ref}. docker_list lists them.`);
  return found;
}

function shape(container: DockerContainer) {
  return {
    id: container.id.slice(0, 12),
    name: container.name,
    image: container.image,
    state: container.state,
    status: container.status,
    composeProject: container.composeProject,
  };
}

async function act(
  ref: string,
  action: (id: string) => Promise<{ ok: boolean; error?: string | null }>,
  done: string,
) {
  const container = await findContainer(ref);
  const result = await action(container.id);
  if (!result.ok) throw new Error(result.error ?? `Docker could not ${done} ${container.name}.`);
  return { text: `${done[0].toUpperCase()}${done.slice(1)} ${container.name}.` };
}

const containerPreview = async (args: { container: string }, verb: string) => {
  const container = await findContainer(args.container);
  return {
    title: `${verb} the container ${container.name}`,
    fields: [
      { label: 'Image', value: container.image, mono: true },
      { label: 'Now', value: container.status },
    ],
  };
};

export const dockerTools = [
  defineTool({
    name: 'docker_list',
    area: 'docker',
    title: 'List Docker containers',
    description:
      "Containers on this computer with their image and state. With forProject, only those started from the project's folder.",
    risk: 'read',
    input: z.object({ projectId: projectIdArg, forProject: z.boolean().optional() }),
    preview: () => ({ title: 'List the Docker containers' }),
    async run(args, context: ToolContext) {
      await requireDocker();
      const containers = args.forProject
        ? await listContainersForProject((await projectOf(context)).folderPath)
        : await listContainers();
      return { data: containers.map(shape) };
    },
  }),

  defineTool({
    name: 'docker_logs',
    area: 'docker',
    title: 'Read container logs',
    description: 'The last lines a container wrote, 200 by default.',
    risk: 'read',
    input: z.object({
      container: containerArg,
      tail: z.number().int().min(1).max(5000).optional(),
    }),
    preview: (args) => ({ title: `Read the logs of ${args.container}` }),
    async run(args) {
      const container = await findContainer(args.container);
      const lines = await readContainerLogs(container.id, { tail: args.tail ?? 200 });
      return { text: lines.map((line) => line.text).join('\n') || '(no output)' };
    },
  }),

  defineTool({
    name: 'docker_start',
    area: 'docker',
    title: 'Start a container',
    description: 'Starts a stopped container.',
    risk: 'write',
    input: z.object({ container: containerArg }),
    preview: (args) => containerPreview(args, 'Start'),
    run: (args) => act(args.container, startContainer, 'started'),
  }),

  defineTool({
    name: 'docker_stop',
    area: 'docker',
    title: 'Stop a container',
    description: 'Stops a running container.',
    risk: 'sensitive',
    input: z.object({ container: containerArg }),
    preview: (args) => containerPreview(args, 'Stop'),
    run: (args) => act(args.container, stopContainer, 'stopped'),
  }),

  defineTool({
    name: 'docker_restart',
    area: 'docker',
    title: 'Restart a container',
    description: 'Restarts a container, interrupting what runs in it.',
    risk: 'sensitive',
    input: z.object({ container: containerArg }),
    preview: (args) => containerPreview(args, 'Restart'),
    run: (args) => act(args.container, restartContainer, 'restarted'),
  }),

  defineTool({
    name: 'docker_remove',
    area: 'docker',
    title: 'Remove a container',
    description:
      'Removes a container, and with removeVolumes its anonymous volumes and their data.',
    risk: 'sensitive',
    input: z.object({ container: containerArg, removeVolumes: z.boolean().optional() }),
    async preview(args) {
      const shown = await containerPreview(args, 'Remove');
      return {
        ...shown,
        summary: args.removeVolumes
          ? 'Its volumes and the data in them are deleted too.'
          : undefined,
      };
    },
    run: (args) =>
      act(
        args.container,
        (id) =>
          removeContainer(id, { removeVolumes: args.removeVolumes === true, removeImage: false }),
        'removed',
      ),
  }),
];
