import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasGit, initGitRepo } from '../../test/main/fixtures';
import {
  assertConflicted,
  assertUntracked,
  readCommitFileImageDiff,
  readFileImageDiff,
  readWorkspaceGitState,
} from './workspaceGit';

/**
 * The changes panel's totals only add up if every side carries line counts. Git hands them over
 * for the staged and unstaged diffs; untracked files are in no diff, so this reads them off disk
 * instead, and that half is what these cover against a real repository.
 */

const git = hasGit();
const lines = (count: number, text = 'line'): string =>
  Array.from({ length: count }, (_, i) => `${text} ${i}`).join('\n') + '\n';

describe.runIf(git)('what a phone may read as a new file', () => {
  it('allows a file git lists as untracked', async () => {
    const repo = initGitRepo({ 'README.md': '# test\n' });
    writeFileSync(join(repo.dir, 'fresh.ts'), 'x\n');

    await expect(assertUntracked(repo.dir, 'fresh.ts')).resolves.toBeUndefined();
  });

  it('refuses a file that is ignored, so a .env stays on the computer', async () => {
    const repo = initGitRepo({ '.gitignore': '.env\n' });
    writeFileSync(join(repo.dir, '.env'), 'SECRET=1\n');

    await expect(assertUntracked(repo.dir, '.env')).rejects.toThrow('.env');
  });

  it('refuses git internals', async () => {
    const repo = initGitRepo({ 'README.md': '# test\n' });

    await expect(assertUntracked(repo.dir, '.git/config')).rejects.toThrow('.git/config');
  });

  it('only resolves a file that is really in conflict', async () => {
    const repo = initGitRepo({ 'README.md': '# test\n' });

    await expect(assertConflicted(repo.dir, 'README.md')).rejects.toThrow('README.md');
  });
});

describe.runIf(git)('readWorkspaceGitState line counts', () => {
  it('counts the lines in an untracked file', async () => {
    const repo = initGitRepo({ 'README.md': '# test\n' });
    writeFileSync(join(repo.dir, 'fresh.ts'), lines(137));

    const state = await readWorkspaceGitState(repo.dir);
    expect(state.untracked).toHaveLength(1);
    expect(state.untracked[0]).toMatchObject({
      path: 'fresh.ts',
      additions: 137,
      deletions: 0,
      binary: false,
    });
  });

  it('counts a last line with no newline after it, and nothing in an empty file', async () => {
    const repo = initGitRepo({ 'README.md': '# test\n' });
    writeFileSync(join(repo.dir, 'no-newline.txt'), 'one\ntwo\nthree');
    writeFileSync(join(repo.dir, 'empty.txt'), '');

    const state = await readWorkspaceGitState(repo.dir);
    const counts = Object.fromEntries(
      state.untracked.map((entry) => [entry.path, entry.additions]),
    );
    expect(counts['no-newline.txt']).toBe(3);
    expect(counts['empty.txt']).toBe(0);
  });

  it('marks an untracked binary file rather than counting it', async () => {
    const repo = initGitRepo({ 'README.md': '# test\n' });
    writeFileSync(join(repo.dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]));

    const state = await readWorkspaceGitState(repo.dir);
    expect(state.untracked[0]).toMatchObject({ binary: true, additions: 0 });
  });

  it('re-reads a file once it changes, and leaves the count alone when it has not', async () => {
    const repo = initGitRepo({ 'README.md': '# test\n' });
    const file = join(repo.dir, 'fresh.ts');
    writeFileSync(file, lines(10));
    expect((await readWorkspaceGitState(repo.dir)).untracked[0]?.additions).toBe(10);

    writeFileSync(file, lines(25));
    expect((await readWorkspaceGitState(repo.dir)).untracked[0]?.additions).toBe(25);
    expect((await readWorkspaceGitState(repo.dir)).untracked[0]?.additions).toBe(25);
  });

  it('still gets its counts from git for the staged and unstaged sides', async () => {
    const repo = initGitRepo({ 'app.ts': lines(30) });
    writeFileSync(join(repo.dir, 'app.ts'), lines(30, 'changed'));
    repo.git('add', 'app.ts');
    writeFileSync(join(repo.dir, 'app.ts'), lines(30, 'changed') + 'one more\n');

    const state = await readWorkspaceGitState(repo.dir);
    expect(state.staged[0]).toMatchObject({ path: 'app.ts', additions: 30, deletions: 30 });
    expect(state.unstaged[0]).toMatchObject({ path: 'app.ts', additions: 1, deletions: 0 });
  });
});

/**
 * The image viewer that stands in for a binary diff. Git hands pictures over as blobs, so what
 * matters here is that both sides come back byte for byte: a checkout filter that turned an LF
 * into a CRLF on the way would leave the viewer showing a broken picture.
 */

/** Two 1x1 PNGs, red and blue. Real files, so git files them as binary the way it would ours. */
const RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);
const BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
  'base64',
);

const asDataUrl = (bytes: Buffer): string => `data:image/png;base64,${bytes.toString('base64')}`;

/** A repository whose one commit holds a red logo.png. */
function repoWithImage(): ReturnType<typeof initGitRepo> {
  const repo = initGitRepo({ 'README.md': '# test\n' });
  writeFileSync(join(repo.dir, 'logo.png'), RED);
  repo.commitAll('add the logo');
  return repo;
}

describe.runIf(git)('readFileImageDiff', () => {
  it('hands both sides of an edited picture over untouched', async () => {
    const repo = repoWithImage();
    writeFileSync(join(repo.dir, 'logo.png'), BLUE);

    const diff = await readFileImageDiff(repo.dir, 'logo.png', 'unstaged');
    expect(diff.tooLarge).toBe(false);
    expect(diff.original).toEqual({ dataUrl: asDataUrl(RED), bytes: RED.length });
    expect(diff.modified).toEqual({ dataUrl: asDataUrl(BLUE), bytes: BLUE.length });
  });

  it('reads the staged side from the index, not from disk', async () => {
    const repo = repoWithImage();
    writeFileSync(join(repo.dir, 'logo.png'), BLUE);
    repo.git('add', 'logo.png');
    // A third version on disk that was never staged must not show up on either staged side.
    writeFileSync(join(repo.dir, 'logo.png'), Buffer.concat([BLUE, Buffer.from([0, 1, 2])]));

    const staged = await readFileImageDiff(repo.dir, 'logo.png', 'staged');
    expect(staged.original?.dataUrl).toBe(asDataUrl(RED));
    expect(staged.modified?.dataUrl).toBe(asDataUrl(BLUE));
  });

  it('gives a brand new file a modified side only', async () => {
    const repo = repoWithImage();
    writeFileSync(join(repo.dir, 'fresh.png'), BLUE);

    const diff = await readFileImageDiff(repo.dir, 'fresh.png', 'untracked');
    expect(diff.original).toBeNull();
    expect(diff.modified?.bytes).toBe(BLUE.length);
  });

  it('gives a deleted file an original side only', async () => {
    const repo = repoWithImage();
    rmSync(join(repo.dir, 'logo.png'));

    const diff = await readFileImageDiff(repo.dir, 'logo.png', 'unstaged');
    expect(diff.original?.dataUrl).toBe(asDataUrl(RED));
    expect(diff.modified).toBeNull();
  });

  it('follows a staged rename back to the name the picture had', async () => {
    const repo = repoWithImage();
    repo.git('mv', 'logo.png', 'brand.png');

    const diff = await readFileImageDiff(repo.dir, 'brand.png', 'staged', 'logo.png');
    expect(diff.original?.dataUrl).toBe(asDataUrl(RED));
    expect(diff.modified?.dataUrl).toBe(asDataUrl(RED));
  });

  it('refuses a path that is not an image', async () => {
    const repo = repoWithImage();
    await expect(readFileImageDiff(repo.dir, 'README.md', 'unstaged')).rejects.toThrow(
      'not an image',
    );
  });
});

describe.runIf(git)('readCommitFileImageDiff', () => {
  it('shows a picture as one commit changed it', async () => {
    const repo = repoWithImage();
    writeFileSync(join(repo.dir, 'logo.png'), BLUE);
    repo.commitAll('repaint the logo');
    const hash = repo.git('rev-parse', 'HEAD').trim();

    const diff = await readCommitFileImageDiff(repo.dir, hash, 'logo.png');
    expect(diff.original?.dataUrl).toBe(asDataUrl(RED));
    expect(diff.modified?.dataUrl).toBe(asDataUrl(BLUE));
  });

  it('leaves the original empty for the commit that added the picture', async () => {
    const repo = repoWithImage();
    const hash = repo.git('rev-parse', 'HEAD').trim();

    const diff = await readCommitFileImageDiff(repo.dir, hash, 'logo.png');
    expect(diff.original).toBeNull();
    expect(diff.modified?.dataUrl).toBe(asDataUrl(RED));
  });
});
