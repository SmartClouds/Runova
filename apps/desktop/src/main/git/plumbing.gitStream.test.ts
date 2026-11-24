import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasGit, initGitRepo, tempDir } from '../../test/main/fixtures';
import { gitStream } from './plumbing';

const git = hasGit();

/** A bare repo reached over file://, which goes through the pack protocol and prints progress. */
function remoteUrl(): string {
  const source = initGitRepo({ 'README.md': '# remote\n', 'src/a.txt': 'a\n' });
  const bare = join(tempDir('runova-bare-'), 'remote.git');
  source.git('clone', '--bare', source.dir, bare);
  return pathToFileURL(bare).href;
}

describe.skipIf(!git)('gitStream', () => {
  it('hands stderr over as it arrives and resolves with stdout', async () => {
    const target = tempDir('runova-stream-');
    const chunks: string[] = [];
    await gitStream(target, ['clone', '--progress', remoteUrl(), '.'], {
      onStderr: (chunk) => chunks.push(chunk),
    });
    expect(chunks.join('')).toMatch(/Receiving objects: 100%/);
    expect(existsSync(join(target, 'README.md'))).toBe(true);
    expect(await gitStream(target, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main\n');
  });

  it('rejects with the whole stderr when git fails', async () => {
    const target = tempDir('runova-stream-');
    const missing = pathToFileURL(join(tempDir('runova-none-'), 'nope.git')).href;
    await expect(gitStream(target, ['clone', missing, '.'])).rejects.toMatchObject({
      stderr: expect.stringMatching(/does not appear to be a git repository|not found/i),
      killed: false,
    });
  });

  it('stops git when the signal aborts and rejects as killed', async () => {
    const target = tempDir('runova-stream-');
    const controller = new AbortController();
    const url = remoteUrl();
    const started = Date.now();
    const run = gitStream(
      target,
      ['clone', '--progress', '--upload-pack=sleep 6; git-upload-pack', url, '.'],
      { signal: controller.signal, onStderr: () => controller.abort() },
    );
    await expect(run).rejects.toMatchObject({ killed: true });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects as killed when it runs past the timeout', async () => {
    const target = tempDir('runova-stream-');
    const run = gitStream(
      target,
      ['clone', '--upload-pack=sleep 6; git-upload-pack', remoteUrl(), '.'],
      { timeoutMs: 500 },
    );
    await expect(run).rejects.toMatchObject({ killed: true });
  });

  it('rejects at once for a signal that was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      gitStream(tempDir('runova-stream-'), ['--version'], { signal: controller.signal }),
    ).rejects.toMatchObject({ killed: true });
  });
});
