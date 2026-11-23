import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../test/main/fixtures';
import { runCli } from './execUtils';

/**
 * Real cmd.exe, no mocks. runCli runs package managers with cwd inside a project the user may
 * have just cloned, and cmd.exe normally looks in the current directory before PATH.
 */
describe.runIf(process.platform === 'win32')('runCli against a real cmd.exe', () => {
  it('runs the command from PATH, not a same-named script the project folder ships', async () => {
    const repo = tempDir('runova-cli-shadow-');
    writeFileSync(join(repo, 'hostname.cmd'), '@echo PLANTED\r\n');

    // Inherited from a parent that already sets it (some terminals do) would hide the bug.
    const inherited = process.env.NoDefaultCurrentDirectoryInExePath;
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    try {
      const { stdout, code } = await runCli('hostname', [], repo);
      expect(code).toBe(0);
      expect(stdout).not.toContain('PLANTED');
      expect(stdout.trim()).not.toBe('');
    } finally {
      if (inherited !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = inherited;
    }
  });
});
