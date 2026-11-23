import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerCleanupSchedule } from '../../../shared/apiTypes';
import type { CleanAction, CleanStep } from './cleanSteps';
import { runLocalScript, type ShellKind } from './machineShell';
import {
  posixCleanScript,
  posixInstallScript,
  posixJobScript,
  posixRemoveScript,
  posixScanScript,
} from './posixScripts';
import { parseCleanLine, parseScanOutput } from './scanParse';
import { DEFAULT_SCHEDULE } from './schedule';
import {
  windowsCleanScript,
  windowsInstallScript,
  windowsJobScript,
  windowsRemoveScript,
  windowsScanScript,
} from './windowsScripts';

/**
 * Runs the real cleanup scripts in a real shell against a runner folder built in a temp folder:
 * PowerShell on Windows, sh on Linux and macOS. Each script is told to look only inside that
 * folder, and the home folders point into it, so nothing on the machine running the tests is
 * scanned or touched. Docker and package-manager commands are left out for the same reason.
 */

const isWindows = process.platform === 'win32';
const kind: ShellKind = isWindows ? 'windows' : 'posix';
const LISTENER = isWindows ? 'Runner.Listener.exe' : 'Runner.Listener';
const DAY_MS = 24 * 60 * 60 * 1000;

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) {
    // Read-only files would make the clean-up of the temp folder fail on Windows.
    spawnSync(isWindows ? 'attrib' : 'true', isWindows ? ['-R', `${root}\\*`, '/S', '/D'] : []);
    rmSync(root, { recursive: true, force: true });
  }
  roots = [];
});

function file(path: string, bytes = 1024): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 7));
}

function age(path: string, days: number): void {
  const when = new Date(Date.now() - days * DAY_MS);
  utimesSync(path, when, when);
}

interface Tree {
  root: string;
  home: string;
  local: string;
  runner: string;
  oldRunner: string;
  gradle: string;
}

function buildTree(): Tree {
  const root = mkdtempSync(join(tmpdir(), 'runova-runner-cleanup-'));
  roots.push(root);
  const home = join(root, 'home');
  const local = join(home, 'AppData', 'Local');
  const runner = join(root, 'actions-runner', 'build-01');
  const oldRunner = join(root, 'actions-runner', 'old-one');

  file(join(runner, 'bin', LISTENER));
  file(join(runner, 'externals', 'node', 'node'));
  file(join(runner, 'bin.2.300.0', LISTENER), 4096);
  file(join(runner, 'externals.2.300.0', 'big'), 10 * 1024);
  file(join(runner, isWindows ? 'config.cmd' : 'config.sh'));
  writeFileSync(
    join(runner, '.runner'),
    `\uFEFF${JSON.stringify({ agentId: 7, agentName: 'build-01', gitHubUrl: 'https://github.com/acme/web' })}`,
  );
  file(join(runner, '_work', 'web', 'web', 'src.txt'), 20 * 1024);
  file(join(runner, '_work', 'web', 'web', '.git', 'objects', 'pack.idx'), 2048);
  chmodSync(join(runner, '_work', 'web', 'web', '.git', 'objects', 'pack.idx'), 0o444);
  file(join(runner, '_work', '_temp', 'leftover.sh'), 5 * 1024);
  file(join(runner, '_work', '_actions', 'actions', 'checkout', 'v4', 'action.yml'));
  file(join(runner, '_work', '_tool', 'node', '18.0.0', 'x64', 'node'), 3 * 1024);
  file(join(runner, '_work', '_tool', 'node', '20.1.0', 'x64', 'node'), 3 * 1024);
  file(join(runner, '_diag', 'Runner_old.log'), 8 * 1024);
  age(join(runner, '_diag', 'Runner_old.log'), 30);
  file(join(runner, '_diag', 'Runner_new.log'));

  file(join(oldRunner, 'bin', LISTENER));
  file(join(oldRunner, isWindows ? 'config.cmd' : 'config.sh'));

  const gradle = join(home, '.gradle', 'caches');
  file(join(gradle, 'modules-2', 'files.bin'), 6 * 1024);
  mkdirSync(local, { recursive: true });
  return { root, home, local, runner, oldRunner, gradle };
}

function envFor(tree: Tree): NodeJS.ProcessEnv {
  return isWindows
    ? { ...process.env, USERPROFILE: tree.home, LOCALAPPDATA: tree.local }
    : { ...process.env, HOME: tree.home };
}

async function run(script: string, tree: Tree): Promise<string> {
  const output = await runLocalScript({ kind, script, timeoutMs: 90_000 }, envFor(tree));
  expect(output.timedOut).toBe(false);
  return output.stdout;
}

const same = (a: string, b: string) => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b);

describe('the scan on this machine', () => {
  it('finds the runner folders and measures what can go', async () => {
    const tree = buildTree();
    const script = isWindows
      ? windowsScanScript({ onlyRoots: [tree.root], skipDocker: true })
      : posixScanScript({ onlyRoots: [tree.root], skipDocker: true });
    const facts = parseScanOutput(await run(script, tree));

    expect(facts.os).toBe(
      isWindows ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    );
    const runner = facts.runners.find((item) => same(item.dir, tree.runner));
    const old = facts.runners.find((item) => same(item.dir, tree.oldRunner));
    expect(facts.runners).toHaveLength(2);
    expect(runner).toMatchObject({
      hasRunnerFile: true,
      configured: true,
      busy: false,
      registration: { agentId: 7, name: 'build-01', url: 'https://github.com/acme/web' },
    });
    expect(old).toMatchObject({ hasRunnerFile: false, configured: true, registration: null });

    const kinds = (runner?.sizes ?? []).map((size) => size.kind).sort();
    expect(kinds).toEqual(
      ['actions', 'checkout', 'diag', 'oldver', 'oldver', 'temp', 'tool', 'tool', 'total'].sort(),
    );
    const sizeOf = (wanted: string) =>
      runner?.sizes.find((size) => size.kind === wanted)?.bytes ?? 0;
    expect(sizeOf('checkout')).toBeGreaterThanOrEqual(20 * 1024);
    expect(sizeOf('total')).toBeGreaterThan(sizeOf('checkout') + sizeOf('temp'));
    expect(sizeOf('temp')).toBeGreaterThanOrEqual(5 * 1024);
    // Only the 30-day-old log counts.
    expect(sizeOf('diag')).toBeGreaterThanOrEqual(8 * 1024);
    expect(sizeOf('diag')).toBeLessThan(10 * 1024);
    const oldVersions = (runner?.sizes ?? []).filter((size) => size.kind === 'oldver');
    expect(oldVersions.map((size) => size.path.split(/[\\/]/).pop()).sort()).toEqual([
      'bin.2.300.0',
      'externals.2.300.0',
    ]);

    expect(facts.caches.find((cache) => cache.id === 'gradle')).toMatchObject({
      bytes: expect.any(Number),
    });
    expect(facts.disk?.totalBytes ?? 0).toBeGreaterThan(0);
    expect(facts.schedule.installed).toBe(false);
  }, 120_000);
});

describe('a cleanup on this machine', () => {
  it('removes exactly the picked things and says what it freed', async () => {
    const tree = buildTree();
    const work = join(tree.runner, '_work');
    const steps: CleanStep[] = [
      {
        id: 'temp',
        busyGuard: tree.runner,
        measure: [join(work, '_temp')],
        actions: [{ kind: 'empty', path: join(work, '_temp') }],
      },
      {
        id: 'checkouts',
        busyGuard: tree.runner,
        measure: [join(work, 'web')],
        actions: [{ kind: 'remove', path: join(work, 'web') }],
      },
      {
        id: 'oldver',
        busyGuard: tree.runner,
        measure: [join(tree.runner, 'bin.2.300.0'), join(tree.runner, 'externals.2.300.0')],
        actions: [
          { kind: 'remove', path: join(tree.runner, 'bin.2.300.0') },
          { kind: 'remove', path: join(tree.runner, 'externals.2.300.0') },
        ],
      },
      {
        id: 'logs',
        busyGuard: null,
        measure: [join(tree.runner, '_diag')],
        actions: [{ kind: 'oldLogs', path: join(tree.runner, '_diag'), days: 7 }],
      },
      {
        id: 'gradle',
        busyGuard: null,
        measure: [tree.gradle],
        actions: [{ kind: 'empty', path: tree.gradle }],
      },
      {
        id: 'gone',
        busyGuard: tree.oldRunner,
        measure: [tree.oldRunner],
        actions: [{ kind: 'removeRunner', path: tree.oldRunner }],
      },
    ];
    const stdout = await run(isWindows ? windowsCleanScript(steps) : posixCleanScript(steps), tree);
    const outcomes = stdout
      .split(/\r?\n/)
      .map(parseCleanLine)
      .filter((item) => item !== null);

    expect(outcomes.map((item) => [item.id, item.status])).toEqual(
      steps.map((step) => [step.id, 'done']),
    );
    for (const outcome of outcomes) expect(outcome.freedBytes).toBeGreaterThan(0);

    expect(readdirSync(join(work, '_temp'))).toEqual([]);
    expect(existsSync(join(work, 'web'))).toBe(false);
    expect(existsSync(join(tree.runner, 'bin.2.300.0'))).toBe(false);
    expect(existsSync(join(tree.runner, 'bin', LISTENER))).toBe(true);
    expect(existsSync(join(tree.runner, 'externals', 'node', 'node'))).toBe(true);
    expect(readdirSync(join(tree.runner, '_diag'))).toEqual(['Runner_new.log']);
    expect(readdirSync(tree.gradle)).toEqual([]);
    expect(existsSync(tree.oldRunner)).toBe(false);
    // Left alone: not picked.
    expect(existsSync(join(work, '_actions', 'actions'))).toBe(true);
    expect(existsSync(join(work, '_tool', 'node', '18.0.0'))).toBe(true);
  }, 120_000);
});

describe('the scheduled job on this machine', () => {
  const schedule: RunnerCleanupSchedule = {
    ...DEFAULT_SCHEDULE,
    rules: {
      temp: true,
      actions: false,
      oldVersions: true,
      toolKeepNewest: true,
      logsOlderThanDays: 7,
      checkoutsOlderThanDays: 3,
      dockerOlderThanHours: null,
      packageCaches: false,
    },
  };

  it('applies its rules to every runner it finds and logs the run', async () => {
    const tree = buildTree();
    const work = join(tree.runner, '_work');
    // A checkout nobody has used for 10 days, children before the folders that hold them.
    for (const path of [
      join(work, 'web', 'web', 'src.txt'),
      join(work, 'web', 'web', '.git', 'objects', 'pack.idx'),
      join(work, 'web', 'web', '.git', 'objects'),
      join(work, 'web', 'web', '.git'),
      join(work, 'web', 'web'),
      join(work, 'web'),
    ]) {
      age(path, 10);
    }

    await run(
      isWindows
        ? windowsJobScript(schedule, { onlyRoots: [tree.root] })
        : posixJobScript(schedule, { onlyRoots: [tree.root] }),
      tree,
    );

    expect(readdirSync(join(work, '_temp'))).toEqual([]);
    expect(existsSync(join(work, 'web'))).toBe(false);
    expect(readdirSync(join(work, '_tool', 'node'))).toEqual(['20.1.0']);
    expect(existsSync(join(tree.runner, 'bin.2.300.0'))).toBe(false);
    expect(readdirSync(join(tree.runner, '_diag'))).toEqual(['Runner_new.log']);
    expect(existsSync(join(work, '_actions', 'actions'))).toBe(true);
    expect(existsSync(join(tree.runner, 'bin', LISTENER))).toBe(true);

    const jobDir = isWindows ? join(tree.local, 'Runova') : join(tree.home, '.runova');
    const log = readFileSync(join(jobDir, 'runner-cleanup.log'), 'utf8')
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\t\d+\tok$/);
    expect(existsSync(join(jobDir, 'runner-cleanup.lock'))).toBe(false);
  }, 120_000);

  // Windows folder names cannot hold a newline, so this one runs on Linux and macOS.
  it.runIf(!isWindows)(
    'deletes an old bin.* folder whose name holds a newline as one folder, never the part after it',
    async () => {
      const tree = buildTree();
      const cwd = join(tree.root, 'cwd');
      file(join(cwd, 'victim', 'keep.txt'));
      file(join(tree.home, 'victim', 'keep.txt'));
      file(join(tree.runner, 'bin.x\nvictim', 'payload'));

      const output = spawnSync('sh', [], {
        cwd,
        env: envFor(tree),
        input: posixJobScript(schedule, { onlyRoots: [tree.root] }),
        encoding: 'utf8',
      });
      expect(output.status).toBe(0);

      expect(existsSync(join(cwd, 'victim', 'keep.txt'))).toBe(true);
      expect(existsSync(join(tree.home, 'victim', 'keep.txt'))).toBe(true);
      expect(existsSync(join(tree.runner, 'bin.x\nvictim'))).toBe(false);
      expect(existsSync(join(tree.runner, 'bin', LISTENER))).toBe(true);
    },
    120_000,
  );
});

describe('the POSIX delete helpers', () => {
  const sh = spawnSync('sh', ['-c', 'exit 0']);
  it.runIf(!sh.error)('refuse a relative path or one with . or .. in it', () => {
    const root = mkdtempSync(join(tmpdir(), 'runova-runner-cleanup-'));
    roots.push(root);
    file(join(root, 'victim', 'keep.txt'));
    file(join(root, 'logs', 'old.log'));
    age(join(root, 'logs', 'old.log'), 30);
    const actions: CleanAction[] = [
      { kind: 'remove', path: 'victim' },
      { kind: 'empty', path: 'victim' },
      { kind: 'oldLogs', path: 'logs', days: 1 },
      { kind: 'remove', path: '/no/such/runner/_work/../../..' },
      { kind: 'remove', path: '/no/such/runner/./x' },
    ];
    const steps: CleanStep[] = actions.map((action, index) => ({
      id: `s${index}`,
      busyGuard: null,
      measure: [],
      actions: [action],
    }));

    const output = spawnSync('sh', [], {
      cwd: root,
      input: posixCleanScript(steps),
      encoding: 'utf8',
    });
    const outcomes = output.stdout
      .split(/\r?\n/)
      .map(parseCleanLine)
      .filter((item) => item !== null);

    expect(outcomes.map((item) => item.status)).toEqual(steps.map(() => 'failed'));
    expect(outcomes[0]?.error).toMatch(/not absolute/);
    expect(outcomes[3]?.error).toMatch(/\. or \.\./);
    expect(existsSync(join(root, 'victim', 'keep.txt'))).toBe(true);
    expect(existsSync(join(root, 'logs', 'old.log'))).toBe(true);
  });
});

describe('a cleanup of a checkout named with curly quotes', () => {
  it.runIf(isWindows)(
    'removes the folder and never runs the text after a quote as PowerShell',
    async () => {
      const tree = buildTree();
      const work = join(tree.runner, '_work');
      const checkouts = ['\u2018', '\u2019', '\u201A', '\u201B'].map((quote) =>
        join(work, `v${quote};RvOut '@@pwned' ${quote.codePointAt(0)};${quote}`),
      );
      for (const path of checkouts) file(join(path, 'src.txt'));
      const steps: CleanStep[] = [
        {
          id: 'checkouts',
          busyGuard: tree.runner,
          measure: checkouts,
          actions: checkouts.map((path) => ({ kind: 'remove' as const, path })),
        },
      ];

      const stdout = await run(windowsCleanScript(steps), tree);

      expect(stdout).not.toContain('@@pwned');
      expect(
        parseCleanLine(stdout.split(/\r?\n/).find((line) => line.startsWith('@@')) ?? ''),
      ).toMatchObject({ id: 'checkouts', status: 'done' });
      for (const path of checkouts) expect(existsSync(path)).toBe(false);
      expect(existsSync(join(work, 'web'))).toBe(true);
    },
    120_000,
  );
});

describe('the install and remove scripts', () => {
  it.runIf(isWindows)(
    'parse as PowerShell',
    () => {
      for (const script of [windowsInstallScript(DEFAULT_SCHEDULE), windowsRemoveScript()]) {
        const check = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); $e.Count',
          ],
          { input: script, encoding: 'utf8' },
        );
        expect(check.stdout.trim()).toBe('0');
      }
    },
    60_000,
  );

  const sh = spawnSync('sh', ['-c', 'exit 0']);
  it.runIf(!sh.error)('parse as sh, for Linux and macOS', () => {
    for (const script of [
      posixInstallScript(DEFAULT_SCHEDULE, 'linux'),
      posixInstallScript(DEFAULT_SCHEDULE, 'macos'),
      posixRemoveScript('linux'),
      posixRemoveScript('macos'),
      posixScanScript(),
      posixJobScript(DEFAULT_SCHEDULE),
    ]) {
      const check = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
      expect(check.stderr).toBe('');
      expect(check.status).toBe(0);
    }
  });
});

describe('a cleanup racing a folder swapped for a junction', () => {
  it.runIf(isWindows)(
    'never deletes what a junction put in place of a folder it listed earlier points at',
    async () => {
      const tree = buildTree();
      const checkout = join(tree.runner, '_work', 'race', 'race');
      const early = join(checkout, 'A');
      file(join(early, 'one.txt'));
      for (let n = 0; n < 5; n += 1) file(join(checkout, 'Z', `f${n}.txt`));
      const victim = join(tree.root, 'victim');
      file(join(victim, 'keep.txt'));
      const steps: CleanStep[] = [
        {
          id: 'checkouts',
          busyGuard: null,
          measure: [checkout],
          actions: [{ kind: 'remove', path: checkout }],
        },
      ];

      // A job process still running as the runner account swaps A, which the cleanup listed but
      // has not reached yet, for a junction while the cleanup works through Z. The hook stands in
      // for that process: it fires on the first item under Z.
      const swap = [
        '$script:RvSwapped = $false',
        '$RvRealIsLink = ${function:RvIsLink}',
        'function RvIsLink($Item) {',
        `  if (-not $script:RvSwapped -and $Item.FullName -like ${psLiteral(`${join(checkout, 'Z')}\*`)}) {`,
        '    $script:RvSwapped = $true',
        `    Rename-Item -LiteralPath ${psLiteral(early)} -NewName 'A2'`,
        `    cmd /c mklink /J ${psLiteral(`"${early}"`)} ${psLiteral(`"${victim}"`)} | Out-Null`,
        '  }',
        '  return & $RvRealIsLink $Item',
        '}',
      ].join('\n');
      const script = windowsCleanScript(steps).replace(/^\$RvId = /m, `${swap}\n$&`);

      const stdout = await run(script, tree);

      expect(stdout).toContain('@@');
      expect(existsSync(join(victim, 'keep.txt'))).toBe(true);
      expect(existsSync(join(checkout, 'Z'))).toBe(false);
    },
    120_000,
  );
});

function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
