import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderItemFile, renderTaskFile } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changesUnder, createPlanCommitter, type PlanCommitOutcome } from './planCommit';
import { type RelayFolder, relayFolder } from './taskFiles';

let root: string;
let folder: RelayFolder;
let enabled: boolean;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
}

function write(path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function committer(delayMs = 20) {
  const outcomes: PlanCommitOutcome[] = [];
  const instance = createPlanCommitter({
    delayMs,
    target: async () => ({ cwd: root, folder, enabled }),
    git: async (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }),
    onOutcome: (_projectId, outcome) => outcomes.push(outcome),
  });
  return { instance, outcomes };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relay-sync-'));
  folder = relayFolder(root, 'docs');
  enabled = true;
  git('init', '--quiet', '--initial-branch', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('README.md', '# app\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'init');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the plan committer', () => {
  it('commits only the plan folder and leaves other staged work staged', async () => {
    write('docs/tasks/T001-login.md', renderTaskFile({ id: 'T001', title: 'Login' }));
    write(
      'docs/tasks/workarounds/W001-pin.md',
      renderItemFile({ kind: 'workaround', id: 'W001', title: 'Pin' }),
    );
    write('src/app.ts', 'export {};\n');
    git('add', 'src/app.ts');

    const { instance } = committer();
    const outcome = await instance.flush('p1');
    expect(outcome).toMatchObject({
      kind: 'committed',
      message: 'docs(tasks): add T001, W001',
    });
    const files = git('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort();
    expect(files).toEqual([
      'docs/tasks/STATUS.md',
      'docs/tasks/T001-login.md',
      'docs/tasks/workarounds/W001-pin.md',
    ]);
    // The other staged file is still staged, and not committed.
    expect(git('diff', '--cached', '--name-only').trim()).toBe('src/app.ts');
    expect(readFileSync(join(folder.tasksDir, 'STATUS.md'), 'utf-8')).toContain(
      '0 of 1 tasks done',
    );
  });

  it('makes no commit when nothing in the plan changed, STATUS.md included', async () => {
    write('docs/tasks/T001-login.md', renderTaskFile({ id: 'T001', title: 'Login' }));
    const { instance } = committer();
    expect((await instance.flush('p1')).kind).toBe('committed');
    expect(await instance.flush('p1')).toEqual({ kind: 'skipped', reason: 'nothing changed' });
    write(
      'docs/tasks/T001-login.md',
      renderTaskFile({ id: 'T001', title: 'Login', status: 'done' }),
    );
    expect(await instance.flush('p1')).toMatchObject({
      kind: 'committed',
      message: 'docs(tasks): update T001',
    });
    expect(git('show', 'HEAD:docs/tasks/STATUS.md')).toContain('1 of 1 tasks done');
  });

  it('waits for a quiet moment and makes one commit for a burst of changes', async () => {
    const { instance, outcomes } = committer(60);
    write('docs/tasks/T001-a.md', renderTaskFile({ id: 'T001', title: 'A' }));
    instance.schedule('p1');
    write('docs/tasks/T002-b.md', renderTaskFile({ id: 'T002', title: 'B' }));
    instance.schedule('p1');
    // Git is slow under load, so this waits for the commit rather than a fixed time.
    await vi.waitFor(() => expect(outcomes).toHaveLength(1), { timeout: 15_000, interval: 50 });
    expect(outcomes[0]).toMatchObject({
      kind: 'committed',
      message: 'docs(tasks): add T001, T002',
    });
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe('2');
  });

  it('stays out of the way: turned off, mid-merge, or before the first commit', async () => {
    write('docs/tasks/T001-login.md', renderTaskFile({ id: 'T001', title: 'Login' }));
    const { instance } = committer();
    enabled = false;
    expect(await instance.flush('p1')).toEqual({ kind: 'skipped', reason: 'turned off' });
    enabled = true;
    writeFileSync(join(root, '.git', 'MERGE_HEAD'), `${git('rev-parse', 'HEAD').trim()}\n`);
    expect((await instance.flush('p1')).kind).toBe('skipped');
    rmSync(join(root, '.git', 'MERGE_HEAD'));

    const fresh = mkdtempSync(join(tmpdir(), 'relay-sync-fresh-'));
    try {
      execFileSync('git', ['-C', fresh, 'init', '--quiet']);
      const empty = createPlanCommitter({
        delayMs: 10,
        target: async () => ({ cwd: fresh, folder: relayFolder(fresh, 'docs'), enabled: true }),
        git: async (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }),
      });
      expect(await empty.flush('p2')).toEqual({ kind: 'skipped', reason: 'no commits yet' });
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
    expect(existsSync(join(folder.tasksDir, 'T001-login.md'))).toBe(true);
  });

  it('commits a file whose name has spaces, a quote and shell characters, as data', async () => {
    write("docs/tasks/T001-it's $(echo no); now.md", renderTaskFile({ id: 'T001', title: 'Odd' }));
    const { instance } = committer();
    expect(await instance.flush('p1')).toMatchObject({ kind: 'committed' });
    expect(git('show', '--name-only', '--format=', 'HEAD')).toContain('T001-it');
  });
});

describe('changesUnder', () => {
  it('reads porcelain entries under a folder, renames included', () => {
    const porcelain = [
      ' M docs/tasks/T001-a.md',
      '?? docs/tasks/decisions/D001-x.md',
      'R  docs/tasks/T002-new.md',
      'docs/tasks/T002-old.md',
      ' M src/app.ts',
    ].join('\0');
    expect(changesUnder(porcelain, 'docs/tasks')).toEqual([
      { code: ' M', path: 'T001-a.md' },
      { code: '??', path: 'decisions/D001-x.md' },
      { code: 'R ', path: 'T002-new.md' },
    ]);
  });
});
