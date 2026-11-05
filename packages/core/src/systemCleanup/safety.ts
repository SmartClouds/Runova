import { type PathFlavour, pathFlavour } from './paths.js';
import type { DevOs } from './types.js';

/**
 * What Disk Cleanup will and will not touch. These rules decide whether a folder may be treated
 * as a cache at all, and whether one path may be removed from inside it, so they are strict and
 * they say why in words.
 *
 * Everything is passed in (the system, the home folder, the folders to protect), so the rules are
 * tested from any machine. The main process runs them on real paths, with links followed, and
 * runs them again just before each removal.
 */

export interface SafetyContext {
  os: DevOs;
  home: string;
  /** Folders that must never be a cache, be inside one, or hold one: Documents, system folders. */
  protectedFolders: readonly string[];
  /** The folders of the person's projects. Their own clean-up handles them, not this one. */
  projectFolders: readonly string[];
}

export type Verdict = { ok: true } | { ok: false; reason: string };

const OK: Verdict = { ok: true };

const refuse = (reason: string): Verdict => ({ ok: false, reason });

/** Folders under the home folder that hold keys and credentials. */
const SENSITIVE_HOME_FOLDERS = ['.ssh', '.gnupg', '.aws', '.kube', '.azure'];

/** System folders on Linux and macOS. Windows gets its own from the caller, which knows the drive. */
const POSIX_SYSTEM_FOLDERS = [
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/run',
  '/System',
  '/Library',
  '/Applications',
  '/private/etc',
];

/** Normalised, with no trailing separator, and in the case the disk compares by. */
function key(path: string, ctx: SafetyContext): string {
  const normal = pathFlavour(ctx.os).normalize(path);
  return ctx.os === 'linux' ? normal : normal.toLowerCase();
}

function isInside(child: string, parent: string, ctx: SafetyContext): boolean {
  const separator = pathFlavour(ctx.os).sep;
  const base = parent.endsWith(separator) ? parent : parent + separator;
  return child === parent || child.startsWith(base);
}

/** Why a path cannot be used at all, before any comparison: not a full path, a network path. */
function malformed(raw: string, ctx: SafetyContext): Verdict | null {
  const path = raw.trim();
  if (path === '') return refuse('There is no path.');
  if (ctx.os === 'win32') {
    if (/^[\\/]{2}/.test(path)) return refuse('That is a network or device path.');
    if (!/^[A-Za-z]:[\\/]/.test(path)) return refuse('That is not a full path (absolute).');
  } else if (!path.startsWith('/')) {
    return refuse('That is not a full path (absolute).');
  }
  if (path.split(/[\\/]+/).includes('..')) return refuse('That path climbs out of its folder.');
  return null;
}

function protectedKeys(ctx: SafetyContext): string[] {
  const flavour: PathFlavour = pathFlavour(ctx.os);
  const home = flavour.normalize(ctx.home);
  const paths = [
    ...ctx.protectedFolders,
    ...SENSITIVE_HOME_FOLDERS.map((name) => flavour.join(home, name)),
    ...(ctx.os === 'win32' ? [] : POSIX_SYSTEM_FOLDERS),
  ];
  return paths.map((path) => key(path, ctx));
}

/** Whether a folder may be treated as a cache: one folder that holds nothing but cache. */
export function assessRoot(root: string, ctx: SafetyContext): Verdict {
  const problem = malformed(root, ctx);
  if (problem) return problem;

  const target = key(root, ctx);
  const flavour = pathFlavour(ctx.os);
  if (key(flavour.rootOf(flavour.normalize(root)), ctx) === target) {
    return refuse('That is a whole drive or the top of the file system, not a cache folder.');
  }

  const home = key(ctx.home, ctx);
  if (target === home) return refuse('That is your home folder.');
  if (isInside(home, target, ctx)) return refuse('That folder holds your home folder.');

  for (const folder of protectedKeys(ctx)) {
    if (isInside(target, folder, ctx)) return refuse('That is, or is inside, a protected folder.');
    if (isInside(folder, target, ctx)) return refuse('That folder holds a protected folder.');
  }

  for (const project of ctx.projectFolders.map((path) => key(path, ctx))) {
    if (isInside(target, project, ctx) || isInside(project, target, ctx)) {
      return refuse('That is, or holds, a project folder. A project is cleaned from its own page.');
    }
  }
  return OK;
}

/** Whether `target` may be removed from inside the cache folder `root`. */
export function assessDeleteTarget(target: string, root: string, ctx: SafetyContext): Verdict {
  const rootVerdict = assessRoot(root, ctx);
  if (!rootVerdict.ok) {
    return refuse(`The cache folder is not safe to clean. ${rootVerdict.reason}`);
  }
  const problem = malformed(target, ctx);
  if (problem) return problem;

  const wanted = key(target, ctx);
  const base = key(root, ctx);
  if (wanted === base) {
    return refuse('That is the cache folder itself. Only what is inside it is removed.');
  }
  if (!isInside(wanted, base, ctx)) return refuse('That is outside the cache folder.');
  return OK;
}
