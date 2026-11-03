import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import {
  countDotenvKeys,
  ENVIRONMENT_KINDS,
  type EnvironmentKind,
  guessEnvironmentKind,
  isEnvFileName,
  MAX_ENV_FILE_BYTES,
} from '@runova/core';
import { z } from 'zod';
import type { ProjectEnvironment } from '../../../shared/apiTypes';
import {
  envFileHistory,
  listEnvironments,
  readEnvFile,
  readEnvFileVersion,
  removeEnvFile,
  restoreEnvFileVersion,
  saveEnvFile,
  saveEnvironment,
  writeEnvToFolder,
} from '../../environments/service';
import { defineTool, type ToolContext } from '../registry';
import { plural, projectIdArg, projectIdOf, projectOf } from './shared';

/**
 * Environment tools: what the Environments tab of a project does, for an agent. An environment is
 * found by its name (any case) or id, and a file by its name, so an agent can say "the .env in
 * Staging" the way a person would. Every change goes through environments/service.ts.
 */

const environmentArg = z
  .string()
  .min(1)
  .describe('The environment, by name (like Staging) or id. env_list lists them.');
const fileNameArg = z.string().min(1).describe('The env file name, like .env or .env.local.');

async function findEnvironment(context: ToolContext, ref: string): Promise<ProjectEnvironment> {
  const environments = await listEnvironments(projectIdOf(context));
  const wanted = ref.trim().toLowerCase();
  const found = environments.find(
    (one) => one.id === ref || one.name.trim().toLowerCase() === wanted,
  );
  if (found) return found;
  const names = environments.map((one) => one.name).join(', ');
  throw new Error(
    names
      ? `No environment named ${ref} in this project. It has: ${names}.`
      : `No environment named ${ref}: this project has none yet. Pass createEnvironment: true to make it.`,
  );
}

function findFile(environment: ProjectEnvironment, fileName: string) {
  const file = environment.files.find((one) => one.fileName === fileName);
  if (!file) {
    const names = environment.files.map((one) => one.fileName).join(', ') || 'no files';
    throw new Error(`${environment.name} has no ${fileName}. It has ${names}.`);
  }
  return file;
}

function kindFromName(name: string): EnvironmentKind {
  const guess = guessEnvironmentKind(`.env.${name.trim().toLowerCase().replace(/\s+/g, '-')}`);
  return guess === 'development' && !/dev|local/i.test(name) ? 'custom' : guess;
}

/** The environment to save into, made on the spot when the agent asked for that. */
async function targetEnvironment(
  context: ToolContext,
  ref: string,
  create: boolean,
): Promise<{ environment: ProjectEnvironment; created: boolean }> {
  try {
    return { environment: await findEnvironment(context, ref), created: false };
  } catch (error) {
    if (!create) throw error;
    const environment = await saveEnvironment({
      projectId: projectIdOf(context),
      name: ref,
      kind: kindFromName(ref),
    });
    return { environment, created: true };
  }
}

async function currentContent(
  context: ToolContext,
  ref: string,
  fileName: string,
): Promise<{ environmentName: string; before: string | null }> {
  const environment = await findEnvironment(context, ref).catch(() => null);
  if (!environment) return { environmentName: ref, before: null };
  const file = environment.files.find((one) => one.fileName === fileName);
  return {
    environmentName: environment.name,
    before: file ? await readEnvFile(environment.id, file.id) : null,
  };
}

async function saveContent(
  context: ToolContext,
  ref: string,
  fileName: string,
  content: string,
  create: boolean,
): Promise<string> {
  const { environment, created } = await targetEnvironment(context, ref, create);
  const existing = environment.files.find((one) => one.fileName === fileName);
  await saveEnvFile({ environmentId: environment.id, id: existing?.id, fileName, content });
  const keys = plural(countDotenvKeys(content), 'key');
  const prefix = created ? `Created the ${environment.name} environment. ` : '';
  return `${prefix}Saved ${fileName} in ${environment.name} (${keys}).${existing ? ' The old version is in its history.' : ''}`;
}

/** Reads the file an agent pointed at, relative to the project folder unless absolute. */
async function readSourceFile(
  context: ToolContext,
  path: string,
): Promise<{ path: string; content: string }> {
  const project = await projectOf(context);
  const full = isAbsolute(path) ? path : resolve(project.folderPath, path);
  try {
    const { size } = await stat(full);
    if (size > MAX_ENV_FILE_BYTES) throw new Error('it is larger than 1 MB');
    return { path: full, content: await readFile(full, 'utf-8') };
  } catch (error) {
    const reason =
      error instanceof Error && !('code' in error)
        ? error.message
        : 'it does not exist or cannot be opened';
    throw new Error(`Could not read ${full}: ${reason}.`);
  }
}

function importName(path: string, fileName: string | undefined): string {
  const name = fileName ?? basename(path);
  if (!isEnvFileName(name)) {
    throw new Error(
      `${name} is not an env file name. Pass fileName, like .env or .env.local, to say what to save it as.`,
    );
  }
  return name;
}

export const environmentTools = [
  defineTool({
    name: 'env_list',
    area: 'environments',
    title: 'List environments',
    description:
      "The project's environments (like Development, Staging, Production) with their env files and credential labels. No values are included.",
    risk: 'read',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    preview: () => ({ title: 'List the environments and their files' }),
    async run(_args, context) {
      const environments = await listEnvironments(projectIdOf(context));
      return {
        data: environments.map((one) => ({
          id: one.id,
          name: one.name,
          kind: one.kind,
          files: one.files.map((file) => ({
            fileName: file.fileName,
            keyCount: file.keyCount,
            updatedAt: new Date(file.updatedAt).toISOString(),
            versions: file.versionCount,
          })),
          credentials: one.credentials.map((credential) => ({
            label: credential.label,
            username: credential.username,
            url: credential.url,
            hasSecret: credential.hasSecret,
          })),
        })),
      };
    },
  }),

  defineTool({
    name: 'env_create',
    area: 'environments',
    title: 'Add an environment',
    description:
      'Adds an empty environment to the project. The kind (development, staging, production, custom) is guessed from the name unless given.',
    risk: 'write',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      name: z.string().min(1).max(60),
      kind: z.enum(ENVIRONMENT_KINDS as [EnvironmentKind, ...EnvironmentKind[]]).optional(),
    }),
    preview: (args) => ({ title: `Add the ${args.name} environment` }),
    async run(args, context) {
      const environment = await saveEnvironment({
        projectId: projectIdOf(context),
        name: args.name,
        kind: args.kind ?? kindFromName(args.name),
      });
      return { text: `Added the ${environment.name} environment (${environment.kind}).` };
    },
  }),

  defineTool({
    name: 'env_read_file',
    area: 'environments',
    title: 'Read an env file',
    description:
      'The full text of one env file, values included. Only read it when the task needs the values.',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      environment: environmentArg,
      fileName: fileNameArg,
    }),
    preview: (args) => ({
      title: `Read ${args.fileName} in ${args.environment}`,
      summary: 'The agent will see every value in this file, secrets included.',
    }),
    async run(args, context) {
      const environment = await findEnvironment(context, args.environment);
      const file = findFile(environment, args.fileName);
      return { text: await readEnvFile(environment.id, file.id) };
    },
  }),

  defineTool({
    name: 'env_save_file',
    area: 'environments',
    title: 'Save an env file',
    description:
      'Creates an env file in an environment, or replaces the whole content of the one with that name. The replaced version stays in the file history. Send the complete file, not a patch.',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      environment: environmentArg,
      fileName: fileNameArg,
      content: z.string().describe('The whole file, in dotenv format.'),
      createEnvironment: z
        .boolean()
        .optional()
        .describe('Make the environment first when the project has none by that name.'),
    }),
    async preview(args, context) {
      const { environmentName, before } = await currentContent(
        context,
        args.environment,
        args.fileName,
      );
      return {
        title: `${before === null ? 'Create' : 'Update'} ${args.fileName} in ${environmentName}`,
        summary:
          before === null
            ? `A new file with ${plural(countDotenvKeys(args.content), 'key')}.`
            : 'Replaces the whole file. The current version stays in its history.',
        diff: { fileName: args.fileName, before: before ?? '', after: args.content, secret: true },
      };
    },
    async run(args, context) {
      return {
        text: await saveContent(
          context,
          args.environment,
          args.fileName,
          args.content,
          args.createEnvironment === true,
        ),
      };
    },
  }),

  defineTool({
    name: 'env_import_file',
    area: 'environments',
    title: 'Save an env file from disk',
    description:
      'Reads a file from disk (a path relative to the project folder, or absolute) and saves it into an environment, replacing the file of that name. Use it when the user says "update it with this file".',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      environment: environmentArg,
      path: z.string().min(1).describe('The file to read.'),
      fileName: fileNameArg
        .optional()
        .describe('What to save it as. Defaults to the file name on disk.'),
      createEnvironment: z.boolean().optional(),
    }),
    async preview(args, context) {
      const source = await readSourceFile(context, args.path);
      const fileName = importName(source.path, args.fileName);
      const { environmentName, before } = await currentContent(context, args.environment, fileName);
      return {
        title: `${before === null ? 'Create' : 'Update'} ${fileName} in ${environmentName} from a file`,
        fields: [{ label: 'From', value: source.path, mono: true }],
        diff: { fileName, before: before ?? '', after: source.content, secret: true },
      };
    },
    async run(args, context) {
      const source = await readSourceFile(context, args.path);
      const fileName = importName(source.path, args.fileName);
      return {
        text: await saveContent(
          context,
          args.environment,
          fileName,
          source.content,
          args.createEnvironment === true,
        ),
      };
    },
  }),

  defineTool({
    name: 'env_remove_file',
    area: 'environments',
    title: 'Delete an env file',
    description: 'Deletes an env file and its history from an environment.',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      environment: environmentArg,
      fileName: fileNameArg,
    }),
    preview: (args) => ({
      title: `Delete ${args.fileName} from ${args.environment}`,
      summary: 'The file and every saved version of it are deleted.',
    }),
    async run(args, context) {
      const environment = await findEnvironment(context, args.environment);
      const file = findFile(environment, args.fileName);
      await removeEnvFile(environment.id, file.id);
      return { text: `Deleted ${file.fileName} from ${environment.name}.` };
    },
  }),

  defineTool({
    name: 'env_history',
    area: 'environments',
    title: 'List versions of an env file',
    description: 'The earlier versions of an env file, newest first, with when each was replaced.',
    risk: 'read',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      environment: environmentArg,
      fileName: fileNameArg,
    }),
    preview: (args) => ({ title: `List the versions of ${args.fileName} in ${args.environment}` }),
    async run(args, context) {
      const environment = await findEnvironment(context, args.environment);
      const file = findFile(environment, args.fileName);
      const versions = await envFileHistory(environment.id, file.id);
      return {
        data: versions.map((version) => ({
          id: version.id,
          keyCount: version.keyCount,
          savedAt: new Date(version.savedAt).toISOString(),
          replacedAt: new Date(version.replacedAt).toISOString(),
        })),
      };
    },
  }),

  defineTool({
    name: 'env_restore_version',
    area: 'environments',
    title: 'Restore an env file version',
    description:
      'Puts an earlier version of an env file back. The current content goes into the history first.',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      environment: environmentArg,
      fileName: fileNameArg,
      versionId: z.string().min(1).describe('From env_history.'),
    }),
    async preview(args, context) {
      const environment = await findEnvironment(context, args.environment);
      const file = findFile(environment, args.fileName);
      return {
        title: `Restore an earlier ${file.fileName} in ${environment.name}`,
        diff: {
          fileName: file.fileName,
          before: await readEnvFile(environment.id, file.id),
          after: await readEnvFileVersion(environment.id, file.id, args.versionId),
          secret: true,
        },
      };
    },
    async run(args, context) {
      const environment = await findEnvironment(context, args.environment);
      const file = findFile(environment, args.fileName);
      await restoreEnvFileVersion(environment.id, file.id, args.versionId);
      return { text: `Restored the earlier ${file.fileName} in ${environment.name}.` };
    },
  }),

  defineTool({
    name: 'env_write_to_folder',
    area: 'environments',
    title: 'Write an env file into the project folder',
    description:
      "Writes a saved env file into the project's folder on disk, so the app can read it. Refuses to replace a file that is there unless overwrite is true, and warns when git does not ignore it.",
    risk: 'sensitive',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      environment: environmentArg,
      fileName: fileNameArg,
      overwrite: z.boolean().optional(),
    }),
    async preview(args, context) {
      const project = await projectOf(context);
      return {
        title: `Write ${args.fileName} from ${args.environment} into the project folder`,
        fields: [
          { label: 'Folder', value: project.folderPath, mono: true },
          { label: 'Replace a file that is there', value: args.overwrite ? 'Yes' : 'No' },
        ],
      };
    },
    async run(args, context) {
      const environment = await findEnvironment(context, args.environment);
      const file = findFile(environment, args.fileName);
      const result = await writeEnvToFolder(environment.id, file.id, args.overwrite === true);
      if (result.status === 'exists') {
        return {
          text: `${result.path} already exists. Call again with overwrite: true to replace it.`,
        };
      }
      return {
        text: `Wrote ${result.path}.${result.notIgnored ? ' Warning: git does not ignore this file, so it could be committed.' : ''}`,
      };
    },
  }),
];
