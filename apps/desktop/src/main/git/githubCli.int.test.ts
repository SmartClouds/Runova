import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/main/fixtures';
import { runGh } from './githubCli';

/**
 * Real process spawning, no mocks. gh runs with cwd set to the project folder, and Windows' own
 * executable search (libuv's, for a spawn without a shell) looks in the child's current
 * directory before PATH, so a repository that commits gh.exe would run instead of the GitHub CLI.
 */
describe.runIf(process.platform === 'win32')('runGh against real process spawning', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.NoDefaultCurrentDirectoryInExePath = process.env.NoDefaultCurrentDirectoryInExePath;
    // A parent that already sets it (some terminals do) would hide the bug.
    delete process.env.NoDefaultCurrentDirectoryInExePath;
  });

  afterEach(() => {
    if (saved.NoDefaultCurrentDirectoryInExePath === undefined) {
      delete process.env.NoDefaultCurrentDirectoryInExePath;
    } else {
      process.env.NoDefaultCurrentDirectoryInExePath = saved.NoDefaultCurrentDirectoryInExePath;
    }
  });

  it('never runs a gh.exe or gh.cmd the project folder ships', async () => {
    const repo = tempDir('runova-gh-shadow-');
    // A copy of node.exe answers --version with Node's own "v26.x.y", which gh never prints.
    copyFileSync(process.execPath, join(repo, 'gh.exe'));
    writeFileSync(join(repo, 'gh.cmd'), '@echo PLANTED\r\n');

    let stdout = '';
    try {
      ({ stdout } = await runGh(['--version'], { cwd: repo, readOnly: true }));
    } catch (error) {
      // No GitHub CLI on this machine: refusing to start anything is the right outcome too.
      stdout = String((error as { stdout?: string }).stdout ?? '');
    }
    expect(stdout).not.toContain('PLANTED');
    expect(stdout.trim()).not.toBe(process.version);
  });
});
