import type { CleanAction, CleanStep } from './cleanSteps';

/**
 * The last check before a runner cleanup deletes anything (E104). The paths came from the
 * machine's own scan, but a confused scan or a planted folder name must still never point a
 * delete at a root, a home folder or anything outside the places the cleanup works in: a runner
 * folder, or a folder inside a home.
 */

export interface SafetyContext {
  home: string;
  runnerDirs: string[];
}

function windowsLike(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function normalize(path: string): string {
  const windows = windowsLike(path);
  const trimmed = path.replace(/[\\/]+$/, '');
  const unified = windows ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed;
  return unified;
}

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || windowsLike(path);
}

function inside(child: string, parent: string): boolean {
  const separator = windowsLike(parent) ? '\\' : '/';
  return child.startsWith(`${parent}${separator}`);
}

function pathsOf(action: CleanAction): string[] {
  switch (action.kind) {
    case 'remove':
    case 'empty':
    case 'oldLogs':
    case 'removeRunner':
      return [action.path];
    case 'toolCommand':
      return [action.fallback];
    case 'docker':
      return [];
  }
}

function checkPath(path: string, context: SafetyContext, removesRunner: boolean): string | null {
  const refused = `Deleting ${path} is not allowed.`;
  if (!path || !isAbsolute(path)) return refused;
  if (segments(path).some((part) => part === '..' || part === '.')) return refused;
  const target = normalize(path);
  // A drive root, `/`, or a folder right under one.
  if (segments(target).length < 2) return refused;
  const home = normalize(context.home);
  const runners = context.runnerDirs.map(normalize);
  if (home && target === home) return refused;
  if (runners.includes(target)) return removesRunner ? null : refused;
  if (removesRunner) return refused;
  if (runners.some((dir) => inside(target, dir))) return null;
  if (home && inside(target, home)) return null;
  // Another account's cache, such as /home/runner/.npm, which the scan reported.
  const parts = segments(target);
  if (parts.length >= 3 && /^(home|users)$/i.test(windowsLike(target) ? parts[1] : parts[0])) {
    return null;
  }
  return refused;
}

/** Why the step must not run, or null when every path in it is fine. */
export function unsafeStep(step: CleanStep, context: SafetyContext): string | null {
  for (const action of step.actions) {
    for (const path of pathsOf(action)) {
      const problem = checkPath(path, context, action.kind === 'removeRunner');
      if (problem) return problem;
    }
  }
  return null;
}
