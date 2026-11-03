import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import {
  SKILLS_SH_PSEUDO_REPOSITORY_ID,
  type Skill,
  type SkillRepository,
  UI_UX_PRO_MAX_PSEUDO_REPOSITORY_ID,
} from '@runova/core';
import { z } from 'zod';
import type { AuditSourceSkill, InstalledSkillRecord } from '../../../shared/apiTypes';
import {
  getRepositoryIndex,
  installRepositorySkill,
  listInstalledSkills,
  listOnDiskSkills,
  removeInstalledSkill,
} from '../../ipc/skills';
import { store } from '../../store';
import { defineTool, type ToolContext } from '../registry';
import { projectIdArg, projectIdOf, projectOf } from './shared';

/**
 * Skill tools: the skills an agent can load, in the project's agent folders (.claude/skills and
 * the like) and in the user's own (~/.claude/skills), reading one, what the repositories added on
 * the Skills page offer, and installing or removing one through the functions that page calls.
 * Installing puts instructions in front of every later agent session, so both changes are sensitive.
 */

type Scope = 'project' | 'user';

const scopeArg = z
  .enum(['project', 'user'])
  .optional()
  .describe(
    "project for the project's agent folders, user for ~/.claude/skills. Leave it out for the project, or the user folder when there is no project.",
  );

const nameArg = z.string().min(1).describe('The skill name, as skills_list shows it.');

/** Skill folder names are plain names; anything else could point outside a skills folder. */
const SAFE_NAME = /^[\w.-]+$/;

/** A SKILL.md is small. Anything much larger than this is not worth sending whole. */
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_LISTED_FILES = 200;

function scopeOf(scope: Scope | undefined, context: ToolContext): Scope {
  return scope ?? (context.projectId ? 'project' : 'user');
}

function projectIdFor(scope: Scope, context: ToolContext): string | null {
  return scope === 'project' ? projectIdOf(context) : null;
}

async function scopeLabel(scope: Scope, context: ToolContext): Promise<string> {
  return scope === 'project' ? (await projectOf(context)).name : 'your user folder';
}

interface FoundSkill extends AuditSourceSkill {
  scope: Scope;
}

async function skillsIn(scope: Scope, context: ToolContext): Promise<FoundSkill[]> {
  const skills = await listOnDiskSkills(projectIdFor(scope, context));
  return skills.map((skill) => ({ ...skill, scope }));
}

/** The record Runova kept when it installed this skill, matched by its folder name. */
function recordFor(records: InstalledSkillRecord[], name: string): InstalledSkillRecord | null {
  return (
    records.find((one) => one.skillId === name || one.skillId.split('/').pop() === name) ?? null
  );
}

function sourceOf(record: InstalledSkillRecord | null, repositories: SkillRepository[]) {
  if (!record) return null;
  if (record.repositoryId === SKILLS_SH_PSEUDO_REPOSITORY_ID) return 'skills.sh';
  if (record.repositoryId === UI_UX_PRO_MAX_PSEUDO_REPOSITORY_ID) return 'ui-ux-pro-max';
  return repositories.find((one) => one.id === record.repositoryId)?.name ?? null;
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path)
    .then((stats) => stats.isDirectory())
    .catch(() => false);
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
    .slice(0, MAX_LISTED_FILES);
}

async function readCapped(path: string): Promise<string> {
  const { size } = await stat(path);
  if (size > MAX_SKILL_BYTES) {
    const text = (await readFile(path)).subarray(0, MAX_SKILL_BYTES).toString('utf-8');
    return `${text}\n\n[Cut off: the file is ${Math.round(size / 1024)} KB.]`;
  }
  return readFile(path, 'utf-8');
}

async function findRepository(ref: string): Promise<SkillRepository> {
  const repositories = await store.getRepositories();
  const wanted = ref.trim().toLowerCase();
  const found = repositories.find(
    (one) => one.id === ref || one.name.trim().toLowerCase() === wanted,
  );
  if (found) return found;
  const names = repositories.map((one) => one.name).join(', ');
  throw new Error(
    `No skill repository named ${ref}. ${names ? `There are: ${names}.` : 'None are added yet; add one on the Skills page.'}`,
  );
}

async function findRepositorySkill(
  ref: string,
  skillRef: string,
): Promise<{ repository: SkillRepository; skill: Skill }> {
  const repository = await findRepository(ref);
  const index = await getRepositoryIndex(repository.id);
  const wanted = skillRef.trim().toLowerCase();
  const skill = index.skills.find(
    (one) => one.id === skillRef || one.name.trim().toLowerCase() === wanted,
  );
  if (!skill) {
    throw new Error(
      `${repository.name} has no skill named ${skillRef}. skills_available lists what it offers.`,
    );
  }
  return { repository, skill };
}

/** The skill to remove, refusing anything that is not a skill folder Runova can remove. */
async function findInstalled(
  name: string,
  scope: Scope,
  context: ToolContext,
): Promise<{ skill: FoundSkill | null; record: InstalledSkillRecord | null }> {
  if (!SAFE_NAME.test(name) || name === '.' || name === '..') {
    throw new Error(`${name} is not a skill name.`);
  }
  const skill = (await skillsIn(scope, context)).find((one) => one.name === name) ?? null;
  const record = recordFor(await listInstalledSkills(projectIdFor(scope, context)), name);
  if (!skill && !record) {
    throw new Error(
      `No skill named ${name} in ${await scopeLabel(scope, context)}. skills_list shows where each one is.`,
    );
  }
  if (record?.repositoryId === UI_UX_PRO_MAX_PSEUDO_REPOSITORY_ID) {
    throw new Error(
      `${name} is removed by its own uninstaller, which runs in a terminal. Remove it on the Skills page.`,
    );
  }
  if (skill && skill.target.kind !== 'installed') {
    throw new Error(
      `${name} is a single file (${skill.location}), not a skill folder, so Runova does not remove it.`,
    );
  }
  return { skill, record };
}

export const skillTools = [
  defineTool({
    name: 'skills_list',
    area: 'skills',
    title: 'List installed skills',
    description:
      "The skills installed in the project's agent folders and in the user's own (~/.claude/skills and the like), with where each one is and which repository Runova installed it from.",
    risk: 'read',
    input: z.object({ projectId: projectIdArg }),
    preview: () => ({ title: 'List the installed skills' }),
    async run(_args, context) {
      const repositories = await store.getRepositories();
      const scopes: Scope[] = context.projectId ? ['project', 'user'] : ['user'];
      const listed = [];
      for (const scope of scopes) {
        const projectId = projectIdFor(scope, context);
        const records = await listInstalledSkills(projectId);
        for (const skill of await skillsIn(scope, context)) {
          listed.push({
            name: skill.name,
            scope,
            location: skill.location,
            installedFrom: sourceOf(recordFor(records, skill.name), repositories),
          });
        }
      }
      return { data: listed };
    },
  }),

  defineTool({
    name: 'skills_read',
    area: 'skills',
    title: 'Read a skill',
    description:
      "One installed skill's SKILL.md, and the names of the other files in its folder. Looks in the project first, then the user folder, unless scope is given.",
    risk: 'read',
    input: z.object({ projectId: projectIdArg, name: nameArg, scope: scopeArg }),
    preview: (args) => ({ title: `Read the skill ${args.name}` }),
    async run(args, context) {
      const scopes: Scope[] = args.scope
        ? [args.scope]
        : context.projectId
          ? ['project', 'user']
          : ['user'];
      for (const scope of scopes) {
        const skill = (await skillsIn(scope, context)).find((one) => one.name === args.name);
        if (!skill) continue;
        if (!(await isDirectory(skill.location))) {
          return {
            data: {
              name: skill.name,
              scope,
              location: skill.location,
              content: await readCapped(skill.location),
              files: [basename(skill.location)],
            },
          };
        }
        const files = await filesUnder(skill.location);
        const entry = files.find((one) => one.toLowerCase() === 'skill.md');
        return {
          data: {
            name: skill.name,
            scope,
            location: skill.location,
            content: entry ? await readCapped(join(skill.location, entry)) : '',
            files,
          },
        };
      }
      throw new Error(`No skill named ${args.name}. skills_list shows the installed ones.`);
    },
  }),

  defineTool({
    name: 'skills_available',
    area: 'skills',
    title: 'Skills in the repositories',
    description:
      'The skill repositories added on the Skills page and the skills each one offers, with id, description and version. skills_install installs one.',
    risk: 'read',
    input: z.object({
      repository: z
        .string()
        .min(1)
        .optional()
        .describe('Only this repository, by name or id. Leave it out for all of them.'),
    }),
    preview: () => ({ title: 'List the skills in your repositories' }),
    async run(args) {
      const repositories = args.repository
        ? [await findRepository(args.repository)]
        : await store.getRepositories();
      const listed = [];
      for (const repository of repositories) {
        try {
          const index = await getRepositoryIndex(repository.id);
          listed.push({
            repository: repository.name,
            repositoryId: repository.id,
            skills: index.skills.map((skill) => ({
              id: skill.id,
              name: skill.name,
              description: skill.description,
              version: skill.version,
            })),
          });
        } catch (error) {
          listed.push({
            repository: repository.name,
            repositoryId: repository.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { data: listed };
    },
  }),

  defineTool({
    name: 'skills_install',
    area: 'skills',
    title: 'Install a skill',
    description:
      "Installs a skill from a repository added on the Skills page into the project's agent folders, or into ~/.claude/skills with scope user. Installing it again updates it.",
    risk: 'sensitive',
    input: z.object({
      projectId: projectIdArg,
      repository: z.string().min(1).describe('The repository, by name or id.'),
      skill: z.string().min(1).describe('The skill, by id or name, from skills_available.'),
      scope: scopeArg,
    }),
    async preview(args, context) {
      const scope = scopeOf(args.scope, context);
      const { repository, skill } = await findRepositorySkill(args.repository, args.skill);
      return {
        title: `Install the skill ${skill.name} into ${await scopeLabel(scope, context)}`,
        summary: skill.description,
        fields: [
          { label: 'Repository', value: repository.name },
          { label: 'Version', value: skill.version },
          { label: 'Files', value: skill.files.map((file) => file.path).join(', '), mono: true },
        ],
      };
    },
    async run(args, context) {
      const scope = scopeOf(args.scope, context);
      const { repository, skill } = await findRepositorySkill(args.repository, args.skill);
      await installRepositorySkill({
        projectId: projectIdFor(scope, context),
        repositoryId: repository.id,
        skillId: skill.id,
      });
      return {
        text: `Installed ${skill.name} ${skill.version} into ${await scopeLabel(scope, context)}.`,
      };
    },
  }),

  defineTool({
    name: 'skills_uninstall',
    area: 'skills',
    title: 'Uninstall a skill',
    description:
      "Removes an installed skill's folder from the project's agent folders, or from the user folder with scope user, along with Runova's record of it.",
    risk: 'sensitive',
    input: z.object({ projectId: projectIdArg, name: nameArg, scope: scopeArg }),
    async preview(args, context) {
      const scope = scopeOf(args.scope, context);
      const { skill } = await findInstalled(args.name, scope, context);
      return {
        title: `Uninstall the skill ${args.name} from ${await scopeLabel(scope, context)}`,
        fields: skill ? [{ label: 'Folder', value: skill.location, mono: true }] : undefined,
      };
    },
    async run(args, context) {
      const scope = scopeOf(args.scope, context);
      const { record } = await findInstalled(args.name, scope, context);
      await removeInstalledSkill({
        projectId: projectIdFor(scope, context),
        skillId: record?.skillId ?? args.name,
      });
      const left = (await skillsIn(scope, context)).find((one) => one.name === args.name);
      if (left) {
        throw new Error(
          `Runova removed what it manages, but ${args.name} is still at ${left.location}.`,
        );
      }
      return { text: `Uninstalled ${args.name} from ${await scopeLabel(scope, context)}.` };
    },
  }),
];
