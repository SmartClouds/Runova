import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CliDefinition } from '@runova/core';

/**
 * Keeps a background run that may write files (version bump, conflict fix, deploy assistant)
 * inside the project it was started for.
 *
 * The run starts in the project's folder, but that alone does not fence the agent in. Claude Code
 * also treats every `additionalDirectories` entry from its own settings as a working directory,
 * and `--permission-mode acceptEdits` approves edits in all of them. A user who once added
 * another repo there (say E:\CuraLink, from a session in that repo) found a version bump started
 * in one project rewriting the version in the other one. So every write run gets two guards:
 * a hard deny rule for each of those folders where the CLI supports one, and a plain statement
 * at the top of the prompt, which is the only thing other CLIs understand.
 */

/** The line in front of a write run's prompt that names the one folder it may change. */
export function writeScopeNote(cwd: string): string {
  return [
    `You are working in the project folder ${cwd}.`,
    'Only create, edit or delete files inside that folder.',
    'Any other folder you can reach (extra working directories from your own settings, for',
    'example) belongs to a different project: never change anything there, even if the task',
    'seems to call for it. If the task cannot be done inside this folder, say so instead.',
    '',
    '',
  ].join('\n');
}

/** Where Claude Code keeps its user settings, honouring CLAUDE_CONFIG_DIR like the CLI does. */
function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), '.claude');
}

async function readAdditionalDirectories(file: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as {
      permissions?: { additionalDirectories?: unknown };
    };
    const dirs = parsed.permissions?.additionalDirectories;
    return Array.isArray(dirs) ? dirs.filter((dir): dir is string => typeof dir === 'string') : [];
  } catch {
    // No settings file, or one that isn't JSON: nothing to fence off from it.
    return [];
  }
}

/** A path in one form for comparing: forward slashes, no trailing slash, any case on Windows. */
function comparable(dir: string): string {
  const slashed = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

function overlaps(a: string, b: string): boolean {
  const left = comparable(a);
  const right = comparable(b);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * The extra working directories Claude Code would give a run in `cwd`, from the user's settings
 * and the project's own, resolved to absolute paths. Folders inside the project, or that hold it,
 * are left out: denying one of those would also deny the project itself.
 */
export async function claudeExtraDirectories(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const files = [
    path.join(claudeConfigDir(env), 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ];
  const listed = (await Promise.all(files.map(readAdditionalDirectories))).flat();
  const resolved = listed
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map((dir) => (dir === '~' || /^~[\\/]/.test(dir) ? path.join(homedir(), dir.slice(1)) : dir))
    .map((dir) => path.resolve(cwd, dir));
  const seen = new Set<string>();
  return resolved.filter((dir) => {
    const key = comparable(dir);
    if (seen.has(key) || overlaps(dir, cwd)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A Claude Code permission rule that blocks every built-in edit tool (Edit, Write, NotebookEdit)
 * under `dir`. Absolute paths take a leading `//`, and Windows paths are matched in POSIX form
 * with a lower-case drive (`E:\CuraLink` is `//e/CuraLink/**`), which is how Claude Code writes
 * them itself.
 */
export function claudeEditDenyRule(dir: string): string {
  const slashed = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  const drive = slashed.match(/^([A-Za-z]):(\/.*)?$/);
  const posix = drive ? `/${drive[1]?.toLowerCase()}${drive[2] ?? ''}` : slashed;
  return `Edit(/${posix}/**)`;
}

/**
 * Extra CLI arguments that stop a write run from editing outside `cwd`. Only Claude Code reads
 * extra working directories from its settings and takes deny rules on the command line; for any
 * other CLI this is empty and the prompt note is the guard.
 */
export async function writeScopeArgs(
  cli: CliDefinition,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  if (cli.id !== 'claude-code') return [];
  const dirs = await claudeExtraDirectories(cwd, env);
  return dirs.length > 0 ? ['--disallowedTools', ...dirs.map(claudeEditDenyRule)] : [];
}
