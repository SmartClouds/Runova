import { runGit } from '../git/versionReview';
import { locateRepo } from '../git/workspaceGit';

/**
 * What git says about a batch of folders: whether it tracks anything inside them, and whether
 * .gitignore leaves them out. This is the guard against offering a folder that holds work, such as
 * a `build/` somebody committed on purpose.
 *
 * Paths are relative to the project folder with forward slashes, and the project folder may be a
 * subfolder of a bigger repository. When git cannot answer, nothing is treated as ignored and
 * everything as tracked, so a failure removes offers instead of adding them.
 */

export interface GitFacts {
  /** The folder is inside a git repository. */
  inRepo: boolean;
  /** Folders with at least one tracked file somewhere inside. */
  tracked: ReadonlySet<string>;
  /** Folders .gitignore leaves out. */
  ignored: ReadonlySet<string>;
}

/** Few enough that the command line stays well under the Windows limit. */
const PATHS_PER_COMMAND = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Every asked-about folder that contains the file, which is its parent folders in the list. */
function foldersHolding(file: string, wanted: ReadonlySet<string>): string[] {
  const parts = file.split('/');
  const found: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join('/');
    if (wanted.has(prefix)) found.push(prefix);
  }
  return found;
}

export async function gitFacts(folder: string, candidates: readonly string[]): Promise<GitFacts> {
  const repo = await locateRepo(folder).catch(() => null);
  const tracked = new Set<string>();
  const ignored = new Set<string>();
  if (!repo) return { inRepo: false, tracked, ignored };
  if (candidates.length === 0) return { inRepo: true, tracked, ignored };

  const wanted = new Set(candidates);

  for (const batch of chunks(candidates, PATHS_PER_COMMAND)) {
    try {
      // Literal, so `[1]` or `*` in a folder name is a name and not a pattern.
      const out = await runGit(folder, [
        '--literal-pathspecs',
        'ls-files',
        '-z',
        '--cached',
        '--',
        ...batch,
      ]);
      for (const file of out.toString('utf8').split('\0')) {
        if (!file) continue;
        for (const holder of foldersHolding(file, wanted)) tracked.add(holder);
      }
    } catch {
      for (const path of batch) tracked.add(path);
    }
  }

  try {
    const out = await runGit(
      folder,
      ['check-ignore', '--stdin', '-z'],
      `${candidates.join('\0')}\0`,
    );
    for (const path of out.toString('utf8').split('\0')) {
      if (wanted.has(path)) ignored.add(path);
    }
  } catch {
    // Exit 1 means none of them is ignored, and any other failure means git could not say.
    // Either way nothing counts as ignored.
  }

  return { inRepo: true, tracked, ignored };
}
