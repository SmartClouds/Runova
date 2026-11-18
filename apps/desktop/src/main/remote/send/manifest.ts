import { randomUUID } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { SEND_LIMITS, safeRelativePath, sendPathKey, transferKeyFromId } from '@runova/protocol';

/** One file of a send: where it is here, and the path it is offered under. */
export interface ManifestFile {
  transferId: string;
  /** Relative, with `/` between folders, the first part the picked file or folder's own name. */
  path: string;
  size: number;
  /** Where the file is on this computer. Never sent. */
  source: string;
}

export interface Manifest {
  files: ManifestFile[];
  totalBytes: number;
  /** What was picked but is not sent, and why, relative to the folder it was in. */
  skipped: { path: string; reason: string }[];
}

export type ManifestProblem = 'too-many-files' | 'too-long-a-list' | 'nothing-to-send';

/** A pick that can not be sent at all, with a sentence that says why. */
export class ManifestError extends Error {
  constructor(
    readonly reason: ManifestProblem,
    message: string,
  ) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** A path separator or a control character, which no name may carry across. */
function badInAName(char: string): boolean {
  const code = char.charCodeAt(0);
  return char === '/' || char === '\\' || code < 0x20 || code === 0x7f;
}

/** A file or folder name as it can travel: separators and control characters become `_`. */
export function sendableName(name: string): string {
  const mended = Array.from(name, (char) => (badInAName(char) ? '_' : char)).join('');
  return mended === '' || mended === '.' || mended === '..' ? '_' : mended;
}

/**
 * Lists everything in what was picked, the way a send offers it (E112). Folders are walked
 * depth first in name order. Links are never followed and special files are skipped, so a send
 * never reaches outside what was picked; anything left out is listed with its reason.
 */
export async function buildManifest(
  paths: string[],
  options: { maxFiles?: number } = {},
): Promise<Manifest> {
  const maxFiles = options.maxFiles ?? SEND_LIMITS.maxFiles;
  const files: ManifestFile[] = [];
  const skipped: Manifest['skipped'] = [];
  const taken = new Set<string>();
  const keys = new Set<number>();
  let offerBytes = 64;

  const add = (path: string, size: number, source: string): void => {
    if (files.length >= maxFiles) {
      throw new ManifestError(
        'too-many-files',
        `That is more than ${maxFiles.toLocaleString('en-US')} files. Send the folder as a zip instead.`,
      );
    }
    let transferId = randomUUID();
    while (keys.has(transferKeyFromId(transferId))) transferId = randomUUID();
    keys.add(transferKeyFromId(transferId));
    taken.add(sendPathKey(path));
    offerBytes += Buffer.byteLength(path) + 80;
    if (offerBytes > SEND_LIMITS.maxOfferBytes) {
      throw new ManifestError(
        'too-long-a-list',
        'The list of files is too long to send in one go. Send the folder as a zip instead.',
      );
    }
    files.push({ transferId, path, size, source });
  };

  const walk = async (dir: string, prefix: string[], base: string): Promise<void> => {
    let entries: string[];
    try {
      const handle = await opendir(dir);
      entries = [];
      for await (const entry of handle) entries.push(entry.name);
    } catch (error) {
      skipped.push({ path: relative(base, dir), reason: unreadable(error) });
      return;
    }
    entries.sort((a, b) => a.localeCompare(b, 'en'));
    for (const name of entries) {
      const source = join(dir, name);
      const parts = [...prefix, sendableName(name)];
      const shown = relative(base, source);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(source);
      } catch (error) {
        skipped.push({ path: shown, reason: unreadable(error) });
        continue;
      }
      if (info.isSymbolicLink()) {
        skipped.push({ path: shown, reason: 'Links are not sent.' });
      } else if (info.isDirectory()) {
        await walk(source, parts, base);
      } else if (!info.isFile()) {
        skipped.push({ path: shown, reason: 'Only ordinary files are sent.' });
      } else {
        const path = parts.join('/');
        const check = travels(path);
        if (check) skipped.push({ path: shown, reason: check });
        else add(path, info.size, source);
      }
    }
  };

  for (const picked of paths) {
    const source = resolve(picked);
    const parent = resolve(source, '..');
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(source);
    } catch (error) {
      skipped.push({ path: basename(source), reason: unreadable(error) });
      continue;
    }
    const name = unusedName(sendableName(basename(source)), taken);
    if (info.isSymbolicLink()) {
      skipped.push({ path: basename(source), reason: 'Links are not sent.' });
    } else if (info.isDirectory()) {
      taken.add(sendPathKey(name));
      await walk(source, [name], parent);
    } else if (info.isFile()) {
      const check = travels(name);
      if (check) skipped.push({ path: basename(source), reason: check });
      else add(name, info.size, source);
    } else {
      skipped.push({ path: basename(source), reason: 'Only ordinary files are sent.' });
    }
  }

  if (files.length === 0) {
    throw new ManifestError(
      'nothing-to-send',
      skipped.length > 0
        ? `There is nothing that can be sent there: ${skipped[0].reason}`
        : 'There are no files in what you picked.',
    );
  }
  return { files, totalBytes: files.reduce((sum, file) => sum + file.size, 0), skipped };
}

/**
 * Where a received file is saved: under `root`, in the folders its path names, mended the same
 * way on every system. Null for a path that would leave `root`.
 */
export function targetFor(root: string, path: string): { dir: string; name: string } | null {
  const safe = safeRelativePath(path);
  if (safe === null) return null;
  const parts = safe.split('/');
  const name = parts.pop() as string;
  const dir = resolve(root, ...parts);
  const back = relative(resolve(root), dir);
  if (back.startsWith('..') || back.includes(`..${sep}`) || resolve(dir) !== dir) return null;
  return { dir, name };
}

/** Why a path can not go in an offer, or null when it can. */
function travels(path: string): string | null {
  if (path.split('/').length > SEND_LIMITS.maxSegments) return 'It is in folders too deep to send.';
  if (path.length > SEND_LIMITS.maxPathChars) return 'Its path is too long to send.';
  if (path.split('/').some((part) => Buffer.byteLength(part) > SEND_LIMITS.maxSegmentBytes)) {
    return 'Its name is too long to send.';
  }
  return safeRelativePath(path) === path ? null : 'Its name can not be sent as it is.';
}

/** `notes.txt`, then `notes (2).txt`, so two picked files of one name both arrive. */
function unusedName(name: string, taken: Set<string>): string {
  if (!taken.has(sendPathKey(name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(sendPathKey(candidate))) return candidate;
  }
}

function unreadable(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'It is not there any more.';
  if (code === 'EACCES' || code === 'EPERM') return 'Runova is not allowed to read it.';
  return 'It could not be read.';
}
