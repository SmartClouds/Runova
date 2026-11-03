import { randomUUID } from 'node:crypto';
import { normalizeProjectWordPressLink, type WpDeployRecord } from '@runova/core';
import { z } from 'zod';
import type {
  DeployWordPressDeployResult,
  DeployWordPressSite,
} from '../../../shared/deployWordPressTypes';
import { wordPressErrorMessage } from '../../../shared/wordpressErrors';
import { liveDeployService } from '../../deploy/liveServices';
import { defineTool, type ToolContext } from '../registry';
import { plural, projectIdArg, projectOf } from './shared';

/**
 * WordPress tools: the sites connected through the Runova Connector plugin, one site's status with
 * its themes and plugins, its deploy history, and the two things the WordPress section does to a
 * live site that an agent may ask for: deploying a linked project and rolling a deploy back. They
 * call the section's own service, which signs every request and keeps the keys sealed. A deploy
 * never goes ahead over conflicts or the site's own warnings; those are for the user to look at
 * in the section.
 */

const siteArg = z
  .string()
  .min(1)
  .max(2048)
  .describe('The site, by its name in Runova, its address or its id. wordpress_sites lists them.');

function wordpress() {
  return liveDeployService('wordpress');
}

/** Runs a service call, passing on what went wrong without the code tag the section reads. */
async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(wordPressErrorMessage(error));
  }
}

function bareUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

async function findSite(ref: string): Promise<DeployWordPressSite> {
  const sites = await call(() => wordpress().listSites());
  const wanted = ref.trim().toLowerCase();
  const found =
    sites.find((site) => site.id === ref) ??
    sites.find((site) => site.label.toLowerCase() === wanted) ??
    sites.find((site) => bareUrl(site.siteUrl) === bareUrl(ref));
  if (!found)
    throw new Error(`No WordPress site named ${ref} is connected. wordpress_sites lists them.`);
  return found;
}

function iso(milliseconds: number | null): string | null {
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function shapeSite(site: DeployWordPressSite) {
  return {
    id: site.id,
    label: site.label,
    siteName: site.siteName,
    siteUrl: site.siteUrl,
    scope: site.scope,
    transport: site.transport,
    connectorVersion: site.pluginVersion,
    connectedAt: iso(site.connectedAt),
    lastSeenAt: iso(site.lastSeenAt),
  };
}

/** The plugin's times are Unix seconds. */
function shapeRecord(record: WpDeployRecord) {
  return {
    deployId: record.deployId,
    state: record.state,
    ...(record.reason ? { reason: record.reason } : {}),
    label: record.label,
    by: record.connectionLabel,
    startedAt: new Date(record.startedAt * 1000).toISOString(),
    finishedAt:
      record.finishedAt === null ? null : new Date(record.finishedAt * 1000).toISOString(),
    filesWritten: record.puts,
    filesDeleted: record.deletes,
    canRollback: record.canRollback,
  };
}

function shapeResult(result: DeployWordPressDeployResult) {
  return {
    deployId: result.deployId,
    state: result.state,
    ...(result.reason ? { reason: result.reason } : {}),
    uploaded: result.uploaded,
    deleted: result.deleted,
    durationMs: result.durationMs,
    health: result.health,
  };
}

/** The project the call is about, with the site it is linked to. */
async function linkedProject(context: ToolContext) {
  const project = await projectOf(context);
  const link = normalizeProjectWordPressLink(project.wordpress);
  if (!link) {
    throw new Error(
      `${project.name} is not linked to a WordPress site. Link it from the WordPress section of Deploy first.`,
    );
  }
  const site = (await call(() => wordpress().listSites())).find((one) => one.id === link.siteId);
  if (!site) throw new Error(`The site ${project.name} is linked to is no longer connected.`);
  return { project, link, site };
}

async function findDeploy(site: DeployWordPressSite, deployId: string): Promise<WpDeployRecord> {
  const records = await call(() => wordpress().history(site.id));
  const found = records.find((record) => record.deployId === deployId);
  if (!found) {
    throw new Error(`${site.label} has no deploy ${deployId}. wordpress_history lists them.`);
  }
  return found;
}

export const wordpressTools = [
  defineTool({
    name: 'wordpress_sites',
    area: 'wordpress',
    title: 'List WordPress sites',
    description:
      'The WordPress sites connected to Runova through the Runova Connector plugin, with their address and whether the connection can write.',
    risk: 'read',
    input: z.object({}),
    preview: () => ({ title: 'List the connected WordPress sites' }),
    async run() {
      return { data: (await call(() => wordpress().listSites())).map(shapeSite) };
    },
  }),

  defineTool({
    name: 'wordpress_site_status',
    area: 'wordpress',
    title: 'Show a WordPress site',
    description:
      "A connected site's WordPress and PHP versions, whether it accepts file changes, and its themes and plugins with which are active.",
    risk: 'read',
    input: z.object({ site: siteArg }),
    preview: (args) => ({ title: `Show the WordPress site ${args.site}` }),
    async run(args) {
      const site = await findSite(args.site);
      const [info, items] = await Promise.all([
        call(() => wordpress().siteInfo(site.id)),
        call(() => wordpress().listItems(site.id)),
      ]);
      return {
        data: {
          id: site.id,
          label: site.label,
          siteUrl: info.siteUrl,
          homeUrl: info.homeUrl,
          wordpress: info.wpVersion,
          php: info.phpVersion,
          connectorVersion: info.pluginVersion,
          https: info.https,
          multisite: info.multisite,
          activeTheme: info.activeTheme.stylesheet,
          fileChangesAllowed:
            !info.fileModsDisabled &&
            !info.readOnlyByConstant &&
            info.filesystemMethod === 'direct',
          rescueGuard: info.guard.installed,
          loopback: info.loopback,
          scope: info.connection.scope,
          items: items.map((item) => ({
            kind: item.kind,
            slug: item.slug,
            name: item.name,
            version: item.version,
            active: item.active || item.networkActive,
            writable: item.writable,
          })),
        },
      };
    },
  }),

  defineTool({
    name: 'wordpress_history',
    area: 'wordpress',
    title: 'Show WordPress deploy history',
    description:
      'The deploys made to a connected site, newest first, and which of them can still be rolled back.',
    risk: 'read',
    input: z.object({ site: siteArg }),
    preview: (args) => ({ title: `Show the deploy history of ${args.site}` }),
    async run(args) {
      const site = await findSite(args.site);
      return { data: (await call(() => wordpress().history(site.id))).map(shapeRecord) };
    },
  }),

  defineTool({
    name: 'wordpress_deploy',
    area: 'wordpress',
    title: 'Deploy to a WordPress site',
    description:
      "Deploys the project's themes and plugins to the WordPress site it is linked to, as the WordPress section does. It stops without changing anything when a file changed on the site too, or the site warns about the change; the user then reviews it in Runova.",
    risk: 'sensitive',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    async preview(_args, context) {
      const { project, link, site } = await linkedProject(context);
      return {
        title: `Deploy ${project.name} to ${site.label}`,
        summary: 'Changed files are written to the live site, which checks its health afterwards.',
        fields: [
          { label: 'Site', value: site.siteUrl },
          {
            label: 'Items',
            value: link.items.map((item) => `${item.kind} ${item.slug}`).join(', '),
            mono: true,
          },
        ],
      };
    },
    async run(_args, context) {
      const { project, site } = await linkedProject(context);
      const plan = await call(() => wordpress().planDeploy({ projectId: project.id }));
      if (plan.conflicts.length > 0) {
        throw new Error(
          `${plural(plan.conflicts.length, 'file')} changed on the site and here since the last sync, so nothing was deployed. The user can review them in the WordPress section of Deploy.`,
        );
      }
      if (plan.changes.length === 0) {
        return {
          text: `${site.label} already has everything in ${project.name}. Nothing to deploy.`,
        };
      }
      const result = await call(() =>
        wordpress().deploy({ planId: plan.planId, operationId: randomUUID(), force: false }),
      );
      return { data: shapeResult(result) };
    },
  }),

  defineTool({
    name: 'wordpress_rollback',
    area: 'wordpress',
    title: 'Roll back a WordPress deploy',
    description:
      'Puts back the files a deploy changed on a connected site, from the snapshot the site kept. wordpress_history says which deploys can be rolled back.',
    risk: 'sensitive',
    input: z.object({
      site: siteArg,
      deployId: z.string().min(1).max(64).describe('The deploy, from wordpress_history.'),
    }),
    async preview(args) {
      const site = await findSite(args.site);
      const record = await findDeploy(site, args.deployId);
      return {
        title: `Roll back a deploy on ${site.label}`,
        summary: 'The files it wrote or deleted go back to how they were before it.',
        fields: [
          { label: 'Site', value: site.siteUrl },
          { label: 'Deploy', value: `${record.label}, ${shapeRecord(record).startedAt}` },
          { label: 'Files', value: `${record.puts} written, ${record.deletes} deleted` },
        ],
      };
    },
    async run(args) {
      const site = await findSite(args.site);
      const record = await findDeploy(site, args.deployId);
      const result = await call(() =>
        wordpress().rollback({
          operationId: randomUUID(),
          siteId: site.id,
          deployId: record.deployId,
        }),
      );
      return { data: shapeResult(result) };
    },
  }),
];
