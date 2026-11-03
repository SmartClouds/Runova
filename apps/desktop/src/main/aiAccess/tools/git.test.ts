import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { initGitRepo } from '../../../test/main/fixtures';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { AiTool, ToolContext } from '../registry';

/**
 * The git tools against a real repository: an agent reads the status, a diff and the log, stages
 * and commits, makes a branch, and throws away a change only after the approval says so.
 */

const userData = useTempUserData();

const context: ToolContext = { projectId: 'p1', callerKind: 'runova', agent: 'Codex', cwd: null };
let repo: ReturnType<typeof initGitRepo>;
let tools: Map<string, AiTool>;

beforeEach(async () => {
  repo = initGitRepo({ 'README.md': '# shop\n', 'src/app.ts': 'export const a = 1;\n' });
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: repo.dir, createdAt: '2026-01-01T00:00:00Z' },
  ]);
  const { gitTools } = await import('./git');
  tools = new Map(gitTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

async function preview(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.preview(tool.input.parse(args), context);
}

describe('git tools', () => {
  it('reports the branch and what changed', async () => {
    writeFileSync(join(repo.dir, 'src/app.ts'), 'export const a = 2;\n');
    writeFileSync(join(repo.dir, 'notes.txt'), 'new\n');

    expect((await run('git_status')).data).toMatchObject({
      branch: 'main',
      staged: [],
      unstaged: [expect.objectContaining({ path: 'src/app.ts' })],
      untracked: [expect.objectContaining({ path: 'notes.txt' })],
    });
  });

  it('shows the diff of the working tree or of what is staged', async () => {
    writeFileSync(join(repo.dir, 'src/app.ts'), 'export const a = 2;\n');

    expect((await run('git_diff')).text).toContain('+export const a = 2;');
    expect((await run('git_diff', { staged: true })).text).toBe('No staged changes.');
  });

  it('stages and commits, and the log shows the commit', async () => {
    writeFileSync(join(repo.dir, 'src/app.ts'), 'export const a = 3;\n');

    await run('git_stage', { paths: ['src/app.ts'] });
    expect((await preview('git_commit', { message: 'Bump a' })).fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Files', value: 'src/app.ts' })]),
    );
    await run('git_commit', { message: 'Bump a' });

    const log = (await run('git_log', { limit: 5 })).data as { subject: string }[];
    expect(log.map((entry) => entry.subject)).toEqual(['Bump a', 'first commit']);
  });

  it('makes and lists branches', async () => {
    await run('git_create_branch', { name: 'feat/login' });
    const branches = (await run('git_branches')).data as { name: string; current: boolean }[];
    expect(branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'feat/login', current: true }),
        expect.objectContaining({ name: 'main', current: false }),
      ]),
    );
  });

  it('throws away an unstaged change only when run, and says what will be lost first', async () => {
    writeFileSync(join(repo.dir, 'src/app.ts'), 'export const a = 9;\n');

    expect(await preview('git_discard', { paths: ['src/app.ts'] })).toMatchObject({
      title: 'Throw away changes to 1 file',
      diff: { fileName: 'src/app.ts', after: 'export const a = 1;\n' },
    });
    expect(readFileSync(join(repo.dir, 'src/app.ts'), 'utf-8')).toBe('export const a = 9;\n');

    await run('git_discard', { paths: ['src/app.ts'] });
    // Git on Windows may check the file out with CRLF line endings.
    expect(readFileSync(join(repo.dir, 'src/app.ts'), 'utf-8').replaceAll('\r\n', '\n')).toBe(
      'export const a = 1;\n',
    );
  });

  it('refuses paths outside the repository', async () => {
    await expect(run('git_stage', { paths: ['../outside.txt'] })).rejects.toThrow();
  });
});
