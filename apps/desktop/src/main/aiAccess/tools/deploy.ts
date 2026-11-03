import { z } from 'zod';
import { coreErrorMessage } from '../../../shared/coreErrors';
import type {
  ContainerSummary,
  JobInfo,
  SiteInfo,
  StackDetails,
  StackInfo,
  StackRevisionInfo,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '../../../shared/deployTypes';
import { liveDeployService } from '../../deploy/liveServices';
import { defineTool } from '../registry';
import { plural } from './shared';

/**
 * Deploy tools: the saved servers, and the apps and websites on each, as the Deploy page shows
 * them, a container's recent logs, and deploying or restarting an app. They call the page's own
 * services on the server's lasting connection, so the core checks the user's role as it does for
 * the page. Logins, keys and env values never come back. Anything that changes a server is
 * sensitive; the firewall, hardening and backups stay on the Deploy page.
 *
 * Only the tools that deploy carry the word in their name, since the word alone marks a tool
 * sensitive; the others are named after what they read.
 */

const serverArg = z
  .string()
  .min(1)
  .max(128)
  .describe('The server, by its name in Runova or its id. hosting_servers lists them.');

const appArg = z
  .string()
  .min(1)
  .max(128)
  .describe('The app, by its name or id. hosting_apps lists the apps on a server.');

/** Runs a core call, passing on what went wrong without the code tag the page reads. */
async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(coreErrorMessage(error));
  }
}

async function findServer(ref: string): Promise<DeployServer> {
  const servers = await liveDeployService('deploy').listServers();
  const wanted = ref.trim().toLowerCase();
  const found =
    servers.find((server) => server.id === ref) ??
    servers.find((server) => server.nickname.toLowerCase() === wanted);
  if (!found) throw new Error(`Runova has no server named ${ref}. hosting_servers lists them.`);
  return found;
}

/** A server with Runova's core on it and this computer enrolled, which the page needs too. */
async function readyServer(ref: string): Promise<DeployServer> {
  const server = await findServer(ref);
  if (!server.core || !server.enrolled) {
    throw new Error(
      `Runova is not set up on ${server.nickname} yet. Set it up from the Deploy page first.`,
    );
  }
  return server;
}

async function findApp(server: DeployServer, ref: string): Promise<StackInfo> {
  const apps = await call(() => liveDeployService('stacks').list(server.id));
  const wanted = ref.trim().toLowerCase();
  const found =
    apps.find((app) => app.id === ref) ?? apps.find((app) => app.name.toLowerCase() === wanted);
  if (!found) {
    throw new Error(`${server.nickname} has no app named ${ref}. hosting_apps lists them.`);
  }
  return found;
}

function appDetails(server: DeployServer, app: StackInfo): Promise<StackDetails> {
  return call(() => liveDeployService('stacks').get(server.id, app.id));
}

function shapeServer(server: DeployServer) {
  return {
    id: server.id,
    name: server.nickname,
    host: server.host,
    port: server.port,
    core: server.core?.version ?? null,
    os: server.core?.os ?? null,
    architecture: server.core?.architecture ?? null,
    enrolled: server.enrolled,
    ...(server.dev ? { dev: true } : {}),
  };
}

function shapeApp(app: StackInfo) {
  return {
    id: app.id,
    name: app.name,
    status: app.status,
    liveRevision: app.liveRevision ?? null,
    revisions: app.revisionCount,
    runningContainers: app.runningContainers,
    containers: app.containers,
    project: app.source?.projectName ?? null,
    composePath: app.source?.composePath ?? null,
    updatedAt: new Date(app.updatedAtUnixMs).toISOString(),
    ...(app.description ? { description: app.description } : {}),
  };
}

function shapeContainer(container: ContainerSummary) {
  return {
    id: container.id.slice(0, 12),
    name: container.name,
    image: container.image,
    state: container.state,
    status: container.status,
    health: container.health,
  };
}

/** A revision without its env key names or compose hash; only what a deploy needs to pick it. */
function shapeRevision(revision: StackRevisionInfo) {
  return {
    number: revision.number,
    state: revision.state,
    createdAt: new Date(revision.createdAtUnixMs).toISOString(),
    services: revision.services,
    unacceptedFindings: revision.unacknowledgedRisks.length,
  };
}

/** A website as the Websites section lists it, without its sign-ins or snippets. */
function shapeSite(site: SiteInfo) {
  const { settings, certificate } = site;
  return {
    id: settings.id,
    domains: settings.domains,
    upstream: {
      kind: settings.upstream.kind,
      ...(settings.upstream.service ? { service: settings.upstream.service } : {}),
      ...(settings.upstream.address ? { address: settings.upstream.address } : {}),
      ...(settings.upstream.port === undefined ? {} : { port: settings.upstream.port }),
    },
    redirectToHttps: settings.redirectToHttps,
    applied: site.applied,
    certificate: certificate
      ? {
          state: certificate.state,
          issuer: certificate.issuer,
          expiresAt: new Date(certificate.notAfterUnixMs).toISOString(),
        }
      : null,
  };
}

function shapeJob(job: JobInfo) {
  return { id: job.id, title: job.title, state: job.state };
}

async function findContainer(server: DeployServer, ref: string): Promise<ContainerSummary> {
  const list = await call(() => liveDeployService('docker').listContainers(server.id));
  const all = list.groups.flatMap((group) => group.containers);
  const wanted = ref.trim().toLowerCase();
  const found =
    all.find((one) => one.id === ref || (ref.length >= 6 && one.id.startsWith(ref))) ??
    all.find((one) => one.name.toLowerCase() === wanted);
  if (!found) {
    throw new Error(
      `${server.nickname} has no container named ${ref}. hosting_apps with an app lists its containers.`,
    );
  }
  return found;
}

interface DeployPick {
  server: DeployServer;
  app: StackInfo;
  revision: StackRevisionInfo;
  live: number | null;
}

/** The revision to deploy: the one asked for, or the live one, or else the newest. */
async function pickRevision(args: {
  server: string;
  app: string;
  revision?: number;
}): Promise<DeployPick> {
  const server = await readyServer(args.server);
  const app = await findApp(server, args.app);
  const details = await appDetails(server, app);
  const number = args.revision ?? app.liveRevision ?? app.revisionCount;
  const revision = details.revisions.find((one) => one.number === number);
  if (!revision) throw new Error(`${app.name} has no revision ${number}.`);
  return { server, app, revision, live: app.liveRevision ?? null };
}

function checkDeployable({ app, revision }: DeployPick): void {
  if (revision.state === 'invalid' || revision.state === 'awaitingContext') {
    throw new Error(
      `Revision ${revision.number} of ${app.name} cannot be deployed (it is ${revision.state}).`,
    );
  }
  if (revision.unacknowledgedRisks.length > 0) {
    throw new Error(
      `The server found ${plural(revision.unacknowledgedRisks.length, 'risk')} in revision ${revision.number} of ${app.name} that nobody accepted yet. Accept or fix them on the Deploy page first.`,
    );
  }
}

export const deployTools = [
  defineTool({
    name: 'hosting_servers',
    area: 'deploy',
    title: 'List Deploy servers',
    description:
      "The servers saved in Runova's Deploy page, with the version of Runova's core on each and whether this computer is enrolled on it.",
    risk: 'read',
    input: z.object({}),
    preview: () => ({ title: 'List the Deploy servers' }),
    async run() {
      return { data: (await liveDeployService('deploy').listServers()).map(shapeServer) };
    },
  }),

  defineTool({
    name: 'hosting_apps',
    area: 'deploy',
    title: 'List the apps on a server',
    description:
      'The apps (compose stacks) on a server, with their status and live revision. With app, that one app in detail: its services, their containers and its revisions.',
    risk: 'read',
    input: z.object({ server: serverArg, app: appArg.optional() }),
    preview: (args) => ({
      title: args.app
        ? `Show the app ${args.app} on ${args.server}`
        : `List the apps on ${args.server}`,
    }),
    async run(args) {
      const server = await readyServer(args.server);
      if (!args.app) {
        const apps = await call(() => liveDeployService('stacks').list(server.id));
        return { data: apps.map(shapeApp) };
      }
      const details = await appDetails(server, await findApp(server, args.app));
      return {
        data: {
          ...shapeApp(details.stack),
          services: details.services.map((service) => ({
            name: service.name,
            image: service.image ?? null,
            containers: service.containers.map(shapeContainer),
          })),
          revisions: details.revisions.map(shapeRevision),
        },
      };
    },
  }),

  defineTool({
    name: 'hosting_websites',
    area: 'deploy',
    title: 'List the websites on a server',
    description:
      'The websites nginx serves on a server: their domains, where each one sends traffic and the state of its HTTPS certificate.',
    risk: 'read',
    input: z.object({ server: serverArg }),
    preview: (args) => ({ title: `List the websites on ${args.server}` }),
    async run(args) {
      const server = await readyServer(args.server);
      const sites = await call(() => liveDeployService('sites').sites(server.id));
      return { data: sites.map(shapeSite) };
    },
  }),

  defineTool({
    name: 'hosting_container_logs',
    area: 'deploy',
    title: 'Read container logs on a server',
    description:
      'The last lines a container on a server wrote, 200 by default. hosting_apps with an app names its containers.',
    risk: 'read',
    input: z.object({
      server: serverArg,
      container: z.string().min(1).max(256).describe('The container, by name or id.'),
      tail: z.number().int().min(1).max(5000).optional(),
    }),
    preview: (args) => ({ title: `Read the logs of ${args.container} on ${args.server}` }),
    async run(args) {
      const server = await readyServer(args.server);
      const container = await findContainer(server, args.container);
      const lines = await call(() =>
        liveDeployService('docker').logTail({
          serverId: server.id,
          containerId: container.id,
          tail: args.tail ?? 200,
        }),
      );
      return { text: lines.map((line) => line.text).join('\n') || '(no output)' };
    },
  }),

  defineTool({
    name: 'deploy_app',
    area: 'deploy',
    title: 'Deploy an app',
    description:
      "Deploys one of an app's revisions on its server: the live one by default, which redeploys what runs now, or an earlier or newer one by number. It does not upload new files from the project; do that from the Deploy page. Returns the server's job.",
    risk: 'sensitive',
    input: z.object({
      server: serverArg,
      app: appArg,
      revision: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('The revision number, from hosting_apps with the app. The live one by default.'),
    }),
    async preview(args) {
      const pick = await pickRevision(args);
      const again = pick.live === pick.revision.number;
      return {
        title: `${again ? 'Redeploy' : 'Deploy'} ${pick.app.name} on ${pick.server.nickname}`,
        summary: again
          ? 'The live revision is deployed again, so its containers are recreated.'
          : `Revision ${pick.revision.number} replaces what runs now.`,
        fields: [
          { label: 'Server', value: `${pick.server.nickname} (${pick.server.host})` },
          { label: 'Revision', value: String(pick.revision.number) },
          { label: 'Live now', value: pick.live === null ? 'none' : String(pick.live) },
        ],
      };
    },
    async run(args) {
      const pick = await pickRevision(args);
      checkDeployable(pick);
      const job = await call(() =>
        liveDeployService('stacks').deploy(pick.server.id, pick.app.id, pick.revision.number),
      );
      return { data: shapeJob(job) };
    },
  }),

  defineTool({
    name: 'hosting_app_restart',
    area: 'deploy',
    title: 'Restart an app',
    description:
      "Restarts every container of an app on its server, as the app's Restart button does. Returns the server's job.",
    risk: 'sensitive',
    input: z.object({ server: serverArg, app: appArg }),
    async preview(args) {
      const server = await readyServer(args.server);
      const app = await findApp(server, args.app);
      return {
        title: `Restart ${app.name} on ${server.nickname}`,
        summary: 'Whatever the app is serving is interrupted while its containers restart.',
        fields: [
          { label: 'Server', value: `${server.nickname} (${server.host})` },
          {
            label: 'Now',
            value: `${app.status}, ${app.runningContainers} of ${app.containers} running`,
          },
        ],
      };
    },
    async run(args) {
      const server = await readyServer(args.server);
      const app = await findApp(server, args.app);
      const job = await call(() =>
        liveDeployService('stacks').action(server.id, app.id, 'restart'),
      );
      return { data: shapeJob(job) };
    },
  }),
];
