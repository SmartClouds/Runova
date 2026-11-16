import { describe, expect, it } from 'vitest';
import type { CleanStep } from './cleanSteps';
import { CONFIG_PREFIX, DEFAULT_SCHEDULE, TASK_NAME } from './schedule';
import {
  WINDOWS_BOOTSTRAP,
  WINDOWS_RUNNER,
  windowsCleanScript,
  windowsInstallScript,
  windowsJobScript,
  windowsRemoveScript,
  windowsScanScript,
} from './windowsScripts';

describe('WINDOWS_RUNNER', () => {
  it('is a short encoded bootstrap that reads the real script from stdin', () => {
    const encoded = WINDOWS_RUNNER.split(' ').at(-1) ?? '';
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(WINDOWS_BOOTSTRAP);
    expect(WINDOWS_BOOTSTRAP).toContain('[Console]::In.ReadToEnd()');
    expect(WINDOWS_BOOTSTRAP).toContain('FromBase64String');
    // cmd.exe, the default OpenSSH shell on Windows, stops at 8191 characters.
    expect(WINDOWS_RUNNER.length).toBeLessThan(2000);
  });
});

describe('windowsScanScript', () => {
  const script = windowsScanScript();

  it('prints the OS, the home and each step', () => {
    expect(script).toContain("RvOut 'os' 'Windows'");
    for (const step of ['runners', 'docker', 'caches', 'schedule']) {
      expect(script).toContain(`RvOut 'step' '${step}'`);
    }
  });

  it('finds runners by their listener and by their services', () => {
    expect(script).toContain('Runner.Listener.exe');
    expect(script).toContain("Name LIKE 'actions.runner.%'");
  });

  it('never walks into a junction or link while measuring', () => {
    expect(script).toContain('[IO.FileAttributes]::ReparsePoint');
  });

  it('checks the Windows cache folders', () => {
    expect(script).toContain("'pip\\Cache'");
    expect(script).toContain("'.gradle\\caches'");
  });

  it('reads the schedule back from the script and Task Scheduler', () => {
    expect(script).toContain(`'${CONFIG_PREFIX}'`);
    expect(script).toContain(`Get-ScheduledTask -TaskName '${TASK_NAME}'`);
  });

  it('only looks in the given folders when told to', () => {
    const narrow = windowsScanScript({ onlyRoots: ["C:\\it's"] });
    expect(narrow).toContain("$RvOnlyRoots = @('C:\\it''s')");
  });
});

const steps: CleanStep[] = [
  {
    id: 'r0-checkouts',
    busyGuard: 'C:\\actions-runner',
    measure: ["C:\\actions-runner\\_work\\it's"],
    actions: [{ kind: 'remove', path: "C:\\actions-runner\\_work\\it's" }],
  },
  {
    id: 'docker-images',
    busyGuard: null,
    measure: [],
    actions: [{ kind: 'docker', prune: 'images' }],
  },
  {
    id: 'cache-npm',
    busyGuard: null,
    measure: ['C:\\Users\\ci\\AppData\\Local\\npm-cache\\_cacache'],
    actions: [
      {
        kind: 'toolCommand',
        tool: 'npm',
        args: ['cache', 'clean', '--force'],
        fallback: 'C:\\Users\\ci\\AppData\\Local\\npm-cache\\_cacache',
      },
    ],
  },
  {
    id: 'gone-0',
    busyGuard: 'D:\\old',
    measure: ['D:\\old'],
    actions: [{ kind: 'removeRunner', path: 'D:\\old' }],
  },
];

describe('windowsCleanScript', () => {
  const script = windowsCleanScript(steps);

  it('quotes paths as literals and removes without following links', () => {
    expect(script).toContain("RvRemove 'C:\\actions-runner\\_work\\it''s'");
    expect(script).toContain('function RvRemove');
  });

  it('skips a busy runner and prints one answer per item', () => {
    expect(script).toContain("if (RvBusy 'C:\\actions-runner')");
    for (const step of steps) expect(script).toContain(`$RvId = '${step.id}'`);
    expect(script).toContain("RvOut '@@donehuman' $RvId");
  });

  it('runs Docker and tool commands with fixed arguments', () => {
    expect(script).toContain("RvDockerPrune @('image', 'prune', '-a', '-f')");
    expect(script).toContain("& 'npm' 'cache' 'clean' '--force'");
  });

  it('removes a runner service only from an administrator shell', () => {
    expect(script).toContain("if (RvUnservice 'D:\\old') { RvRemove 'D:\\old' }");
    expect(script).toContain('sc.exe');
  });
});

describe('windowsJobScript', () => {
  it('carries its settings, logs each run and keeps 200 lines', () => {
    const script = windowsJobScript(DEFAULT_SCHEDULE);
    expect(script).toContain(`${CONFIG_PREFIX}${JSON.stringify(DEFAULT_SCHEDULE)}`);
    expect(script).toContain('runner-cleanup.log');
    expect(script).toContain('-Tail 200');
    expect(script).toContain('until=72h');
  });
});

describe('windowsInstallScript', () => {
  it('writes the job script and registers the task, falling back to signed-in only', () => {
    const script = windowsInstallScript(DEFAULT_SCHEDULE);
    expect(script).toContain('runner-cleanup.ps1');
    expect(script).toContain(`Register-ScheduledTask -TaskName '${TASK_NAME}' -Xml`);
    expect(script).toContain('InteractiveToken');
    expect(script).toContain("RvOut '@@ok' 'interactive'");
  });
});

describe('windowsRemoveScript', () => {
  it('unregisters the task and deletes the script', () => {
    const script = windowsRemoveScript();
    expect(script).toContain(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false`);
    expect(script).toContain('runner-cleanup.ps1');
  });
});
