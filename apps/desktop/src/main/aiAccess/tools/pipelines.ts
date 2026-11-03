import type { ProviderUsage } from '@runova/core';
import { z } from 'zod';
import {
  cancelWorkflowRun,
  dispatchWorkflow,
  fetchProjectPipelineStatus,
  fetchRunFailureText,
} from '../../pipelines/githubActions';
import { store } from '../../store';
import { getAllUsage } from '../../usage';
import { defineTool } from '../registry';
import { projectIdArg, projectOf } from './shared';

/**
 * Pipeline and usage tools: a project's GitHub Actions as the Pipelines page shows them, why a
 * run failed, starting or cancelling a run, and the AI usage the Usage page shows. Starting or
 * cancelling a run acts on GitHub, so those are sensitive.
 */

async function repoOf(context: Parameters<typeof projectOf>[0]): Promise<string> {
  const status = await fetchProjectPipelineStatus(await projectOf(context));
  if (!status.github) throw new Error(status.error ?? 'This project has no GitHub repository.');
  return `${status.github.owner}/${status.github.repo}`;
}

/** The totals and limits, without the chart series and per-project tables the page draws. */
function usageShape(usage: ProviderUsage) {
  const { series: _series, costSeries: _cost, projectDaily: _daily, ...rest } = usage;
  return rest;
}

export const pipelineTools = [
  defineTool({
    name: 'pipelines_status',
    area: 'pipelines',
    title: 'Pipeline status',
    description:
      "The project's GitHub Actions workflows with the latest run of each: status, conclusion, branch and link.",
    risk: 'read',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    preview: () => ({ title: 'Read the pipeline status' }),
    async run(_args, context) {
      const status = await fetchProjectPipelineStatus(await projectOf(context));
      if (!status.cliAvailable) throw new Error('The GitHub CLI (gh) is not installed.');
      if (!status.authenticated) throw new Error('The GitHub CLI is not signed in.');
      return {
        data: {
          repo: status.github ? `${status.github.owner}/${status.github.repo}` : null,
          workflows: status.workflows.map((workflow) => {
            const run = status.runsByWorkflowId[workflow.id];
            return {
              id: workflow.id,
              name: workflow.name,
              latestRun: run
                ? {
                    id: run.id,
                    title: run.displayTitle,
                    branch: run.headBranch,
                    status: run.status,
                    conclusion: run.conclusion,
                    url: run.htmlUrl,
                    createdAt: run.createdAt,
                  }
                : null,
            };
          }),
        },
      };
    },
  }),

  defineTool({
    name: 'pipelines_failure_log',
    area: 'pipelines',
    title: 'Why a pipeline run failed',
    description:
      'The failing steps and their log lines for one workflow run, from pipelines_status.',
    risk: 'read',
    needsProject: true,
    input: z.object({ projectId: projectIdArg, runId: z.number().int().positive() }),
    preview: (args) => ({ title: `Read why run ${args.runId} failed` }),
    async run(args, context) {
      const result = await fetchRunFailureText({ repo: await repoOf(context), runId: args.runId });
      if (!result.ok) throw new Error(result.error);
      return { text: result.text };
    },
  }),

  defineTool({
    name: 'pipelines_dispatch',
    area: 'pipelines',
    title: 'Start a workflow',
    description: 'Starts a workflow that has a manual trigger on a branch or tag, with its inputs.',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      workflowId: z.number().int().positive(),
      ref: z.string().min(1).describe('The branch or tag to run it on.'),
      inputs: z.record(z.string(), z.string()).optional(),
    }),
    async preview(args, context) {
      return {
        title: `Start workflow ${args.workflowId} on ${args.ref}`,
        fields: [
          { label: 'Repository', value: await repoOf(context), mono: true },
          ...Object.entries(args.inputs ?? {}).map(([label, value]) => ({ label, value })),
        ],
      };
    },
    async run(args, context) {
      const result = await dispatchWorkflow({
        repo: await repoOf(context),
        workflowId: args.workflowId,
        ref: args.ref,
        inputs: args.inputs ?? {},
      });
      if (!result.ok) throw new Error(result.error);
      return { text: `Started workflow ${args.workflowId} on ${args.ref}.` };
    },
  }),

  defineTool({
    name: 'pipelines_cancel_run',
    area: 'pipelines',
    title: 'Cancel a workflow run',
    description: 'Cancels a workflow run that is queued or in progress.',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({ projectId: projectIdArg, runId: z.number().int().positive() }),
    preview: (args) => ({ title: `Cancel run ${args.runId}` }),
    async run(args, context) {
      const result = await cancelWorkflowRun({ repo: await repoOf(context), runId: args.runId });
      if (!result.ok) throw new Error(result.error);
      return { text: `Cancelled run ${args.runId}.` };
    },
  }),

  defineTool({
    name: 'usage_summary',
    area: 'usage',
    title: 'AI usage and limits',
    description:
      'Token use, cost and plan limits for each AI provider the Usage page tracks, like Claude Code, Codex and Cursor.',
    risk: 'read',
    input: z.object({}),
    preview: () => ({ title: 'Read your AI usage and limits' }),
    async run() {
      const settings = await store.getSettings();
      const usage = await getAllUsage(settings.usageProviderConfigs ?? {});
      return { data: usage.map(usageShape) };
    },
  }),
];
