import {
  buildSentrySetup,
  SENTRY_PLATFORMS,
  sentryPlatform,
  suggestSentryPlatform,
} from '@runova/core';
import { z } from 'zod';
import type { ErrorIssueSummary } from '../../../shared/errorTrackingTypes';
import { getErrorTrackingService } from '../../errorTracking/service';
import {
  errorCreateProjectSchema,
  errorIssueQuerySchema,
  errorIssueRefSchema,
  errorProjectKeysSchema,
  errorStatusChangeSchema,
} from '../../ipc/errorTracking';
import { store } from '../../store';
import { defineTool } from '../registry';
import { projectIdArg } from './shared';

/**
 * Error tracking tools: the Sentry issues the Monitoring page's Errors tab shows, one issue with
 * its latest event, and resolving, ignoring or reopening an issue as the tab's buttons do. They go
 * through the same service as the tab, which never hands out a token, and the issues and events
 * it returns are already redacted by the parser. Arguments are checked with the tab's own schemas.
 *
 * An agent can also make a new Sentry project, linked to the project it works on, and read the
 * DSN of one, with the setup snippet the tab shows next to it.
 */

const query = errorIssueQuerySchema.shape;

function issueShape(issue: ErrorIssueSummary) {
  return {
    connectionId: issue.connectionId,
    issueId: issue.id,
    shortId: issue.shortId,
    title: issue.title,
    culprit: issue.culprit,
    level: issue.level,
    status: issue.status,
    count: issue.count,
    userCount: issue.userCount,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    isNew: issue.isNew,
    projectId: issue.projectId,
    remoteProject: issue.remoteProjectSlug,
    permalink: issue.permalink,
  };
}

const platformIds = SENTRY_PLATFORMS.map((one) => one.id) as [string, ...string[]];

/** The snippet that puts a DSN to work, without the function that builds it. */
function setupShape(platformId: string, dsn: string) {
  const setup = buildSentrySetup(platformId, dsn);
  return {
    platform: setup.platform.label,
    install: setup.install,
    where: setup.platform.where,
    code: setup.code,
    env: setup.env,
    docsUrl: setup.platform.docsUrl,
  };
}

/** The team a new project goes under: the one asked for, or the organization's only one. */
async function teamFor(connectionId: string, teamSlug: string | undefined): Promise<string> {
  if (teamSlug) return teamSlug;
  const teams = await getErrorTrackingService().teams(connectionId);
  if (teams.length === 1) return teams[0].slug;
  if (teams.length === 0) {
    throw new Error('The organization has no team the token can see, and a project needs one.');
  }
  throw new Error(`Pass teamSlug, one of: ${teams.map((team) => team.slug).join(', ')}.`);
}

const create = errorCreateProjectSchema.shape;

const STATUS_VERB = { resolved: 'Resolve', ignored: 'Ignore', unresolved: 'Reopen' } as const;
const STATUS_DONE = { resolved: 'Resolved', ignored: 'Ignored', unresolved: 'Reopened' } as const;

export const errorTrackingTools = [
  defineTool({
    name: 'errors_issues',
    area: 'errorTracking',
    title: 'Error tracking issues',
    description:
      "The Sentry issues of the project's linked error tracking projects, as the Errors tab lists them: unresolved ones from the last 14 days, most recently seen first, by default. Leave projectId out, outside a project, to list every linked project's issues. Pass nextCursor back as cursor for more.",
    risk: 'read',
    input: z.object({
      projectId: projectIdArg,
      status: query.status.default('unresolved'),
      period: query.period.default('14d'),
      sort: query.sort.default('lastSeen'),
      environment: z.string().max(200).optional(),
      search: query.search.describe('Text passed to the Sentry search, like "is:new checkout".'),
      cursor: z.string().max(8192).optional(),
      refresh: z.boolean().optional().describe('Skip the one minute cache.'),
    }),
    preview: () => ({ title: 'Read the error tracking issues' }),
    async run(args, context) {
      const service = getErrorTrackingService();
      const projectId = context.projectId ?? undefined;
      const links = await service.listLinks(projectId ? { projectId } : {});
      if (links.length === 0) {
        return {
          text: projectId
            ? 'This project has no error tracking project linked. Link a Sentry project to it on the Monitoring page, Errors tab.'
            : 'No Runova project has an error tracking project linked yet. Link one on the Monitoring page, Errors tab.',
        };
      }
      const { projectId: _ignored, ...filter } = args;
      const page = await service.listIssues(
        Object.fromEntries(
          Object.entries({ ...filter, projectId }).filter(([, value]) => value !== undefined),
        ) as z.infer<typeof errorIssueQuerySchema>,
      );
      return {
        data: {
          issues: page.issues.map(issueShape),
          nextCursor: page.nextCursor,
          failures: page.failures.map((failure) => ({
            connection: failure.label,
            message: failure.message,
            locked: failure.locked,
          })),
        },
      };
    },
  }),

  defineTool({
    name: 'errors_issue',
    area: 'errorTracking',
    title: 'One error tracking issue',
    description:
      'One issue from errors_issues with its latest event: the exception chain with stack frames and source lines, breadcrumbs, request, tags, release and environment. Says too whether it can be resolved from Runova.',
    risk: 'read',
    input: errorIssueRefSchema,
    preview: (args) => ({ title: `Read error issue ${args.issueId}` }),
    async run(args) {
      const detail = await getErrorTrackingService().getIssue(args);
      return {
        data: { issue: issueShape(detail.issue), event: detail.event, canWrite: detail.canWrite },
      };
    },
  }),

  defineTool({
    name: 'errors_set_status',
    area: 'errorTracking',
    title: 'Resolve or ignore an issue',
    description:
      'Marks an issue resolved, ignored (for good, or for ignoreMinutes) or unresolved again in Sentry, like the buttons on the Errors tab. Needs a token with write access.',
    risk: 'write',
    input: errorStatusChangeSchema,
    async preview(args) {
      let name = args.issueId;
      let title: string | null = null;
      try {
        const detail = await getErrorTrackingService().getIssue({
          connectionId: args.connectionId,
          issueId: args.issueId,
        });
        name = detail.issue.shortId;
        title = detail.issue.title;
      } catch {
        // The id alone is enough to decide on.
      }
      return {
        title: `${STATUS_VERB[args.status]} ${name}`,
        fields: [
          ...(title ? [{ label: 'Issue', value: title }] : []),
          ...(args.status === 'ignored' && args.ignoreMinutes
            ? [{ label: 'Ignore for', value: `${args.ignoreMinutes} minutes` }]
            : []),
        ],
      };
    },
    async run(args) {
      const issue = await getErrorTrackingService().setIssueStatus(args);
      return { text: `${STATUS_DONE[args.status]} ${issue.shortId}: ${issue.title}` };
    },
  }),

  defineTool({
    name: 'errors_connections',
    area: 'errorTracking',
    title: 'Error tracking connections',
    description:
      'The Sentry organizations Runova is connected to (never their tokens), whether each can resolve issues or has a problem, and which Sentry projects are linked to which Runova projects.',
    risk: 'read',
    input: z.object({}),
    preview: () => ({ title: 'Read the error tracking connections' }),
    async run() {
      const service = getErrorTrackingService();
      const [connections, links] = await Promise.all([
        service.listConnections(),
        service.listLinks(),
      ]);
      return {
        data: {
          connections: connections.map((connection) => ({
            id: connection.id,
            provider: connection.provider,
            label: connection.label,
            host: connection.host,
            orgSlug: connection.orgSlug,
            orgName: connection.orgName,
            canWrite: connection.canWrite,
            canCreateProjects: connection.canCreateProjects,
            locked: connection.locked,
            problem: connection.problem,
          })),
          links,
        },
      };
    },
  }),

  defineTool({
    name: 'errors_create_project',
    area: 'errorTracking',
    title: 'Create a Sentry project',
    description:
      'Makes a new project in a connected Sentry organization and hands back its DSN with the install command and init code for the platform. It is linked to the project the agent works on unless link is false. Leave teamSlug out when the organization has one team. Needs a token with project:write; errors_connections says which can.',
    risk: 'write',
    input: z.object({
      connectionId: create.connectionId.describe('From errors_connections.'),
      name: z.string().min(1).max(50).describe('The Sentry project name; Sentry makes the slug.'),
      teamSlug: create.teamSlug.optional(),
      platform: z
        .enum(platformIds)
        .optional()
        .describe('Which setup snippet to return, and the platform Sentry records.'),
      projectId: projectIdArg,
      link: z.boolean().default(true).describe('Link the new project to the Runova project.'),
    }),
    async preview(args, context) {
      const connections = await getErrorTrackingService()
        .listConnections()
        .catch(() => []);
      const connection = connections.find((one) => one.id === args.connectionId);
      const linkTo = args.link ? context.projectId : null;
      let projectName = linkTo;
      if (linkTo) {
        const projects = await store.getProjects().catch(() => []);
        projectName = projects.find((one) => one.id === linkTo)?.name ?? linkTo;
      }
      return {
        title: `Create the Sentry project "${args.name}"`,
        fields: [
          { label: 'Organization', value: connection?.label ?? args.connectionId },
          ...(args.teamSlug ? [{ label: 'Team', value: args.teamSlug }] : []),
          ...(args.platform
            ? [{ label: 'Platform', value: sentryPlatform(args.platform).label }]
            : []),
          ...(projectName ? [{ label: 'Link to', value: projectName }] : []),
        ],
      };
    },
    async run(args, context) {
      const teamSlug = await teamFor(args.connectionId, args.teamSlug);
      const created = await getErrorTrackingService().createProject({
        connectionId: args.connectionId,
        teamSlug,
        name: args.name,
        platform: args.platform ?? null,
        linkProjectId: args.link ? context.projectId : null,
      });
      const platformId = args.platform ?? suggestSentryPlatform(created.project.platform);
      return {
        data: {
          project: created.project,
          dsn: created.dsn,
          keysUrl: created.keysUrl,
          linkedTo: created.link?.projectId ?? null,
          setup: created.dsn ? setupShape(platformId, created.dsn) : null,
        },
      };
    },
  }),

  defineTool({
    name: 'errors_project_keys',
    area: 'errorTracking',
    title: 'Sentry project DSN',
    description:
      "A Sentry project's client keys (the public DSN an app sends its errors to, never the secret), with the setup snippet for its platform. remoteSlug is a linked project's remoteSlug from errors_connections.",
    risk: 'read',
    input: errorProjectKeysSchema.extend({
      platform: z.enum(platformIds).optional().describe('Which setup snippet to return.'),
    }),
    preview: (args) => ({ title: `Read the DSN of the Sentry project ${args.remoteSlug}` }),
    async run(args) {
      const { keys, keysUrl } = await getErrorTrackingService().projectKeys({
        connectionId: args.connectionId,
        remoteSlug: args.remoteSlug,
      });
      const dsn = keys.find((key) => key.isActive)?.dsn ?? null;
      return {
        data: {
          keys,
          keysUrl,
          setup: dsn ? setupShape(args.platform ?? 'other', dsn) : null,
        },
      };
    },
  }),
];
