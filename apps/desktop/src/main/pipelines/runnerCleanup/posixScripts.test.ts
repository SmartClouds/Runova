import { describe, expect, it } from 'vitest';
import type { CleanStep } from './cleanSteps';
import {
  POSIX_RUNNER,
  posixCleanScript,
  posixInstallAnyScript,
  posixInstallScript,
  posixJobScript,
  posixRemoveAnyScript,
  posixRemoveScript,
  posixScanScript,
} from './posixScripts';
import { CONFIG_PREFIX, DEFAULT_SCHEDULE } from './schedule';

describe('POSIX_RUNNER', () => {
  it('reads the whole script from stdin before running it, so no command can eat the rest', () => {
    expect(POSIX_RUNNER).toBe(`sh -c 'S=$(cat); eval "$S"'`);
  });
});

describe('posixScanScript', () => {
  const script = posixScanScript();

  it('prints the OS, the home and each step', () => {
    expect(script).toContain('rv_out os "$(uname -s)"');
    expect(script).toContain('rv_out home "$RV_HOME"');
    for (const step of ['runners', 'docker', 'caches', 'schedule']) {
      expect(script).toContain(`rv_out step ${step}`);
    }
  });

  it('finds runners by their listener and by their systemd and launchd services', () => {
    expect(script).toContain("-path '*/bin*/Runner.Listener'");
    expect(script).toContain('/etc/systemd/system/actions.runner.*.service');
    expect(script).toContain('Library/LaunchAgents/actions.runner.*.plist');
  });

  it('uses only flags GNU and BSD tools share', () => {
    expect(script).toContain('du -sk');
    expect(script).toContain('df -Pk');
    // BSD sed has no \t in a replacement; tabs come from printf and awk instead.
    expect(script).not.toMatch(/sed [^|\n]*\\t/);
    expect(script).not.toContain('du -sb');
    expect(script).not.toContain('--max-depth');
    expect(script).not.toContain('stat -c');
  });

  it('checks the cache folders each OS uses', () => {
    expect(script).toContain('.cache/pip');
    expect(script).toContain('Library/Caches/pip');
  });

  it('asks Docker for its figures, with sudo -n as the fallback', () => {
    expect(script).toContain("system df --format '{{json .}}'");
    expect(script).toContain('sudo -n docker info');
  });

  it('only looks in the given folders when told to', () => {
    const narrow = posixScanScript({ onlyRoots: ["/tmp/it's"] });
    expect(narrow).toContain(`RV_ONLY_ROOTS=1`);
    expect(narrow).toContain(`'/tmp/it'\\''s'`);
  });

  it('reads the schedule back', () => {
    expect(script).toContain(CONFIG_PREFIX.trim());
    expect(script).toContain('crontab -l');
    expect(script).toContain('com.runova.runner-cleanup.plist');
  });
});

const steps: CleanStep[] = [
  {
    id: 'r0-checkouts',
    busyGuard: '/home/ci/actions-runner/a',
    measure: ['/home/ci/actions-runner/a/_work/web', "/home/ci/it's"],
    actions: [
      { kind: 'remove', path: '/home/ci/actions-runner/a/_work/web' },
      { kind: 'remove', path: "/home/ci/it's" },
    ],
  },
  {
    id: 'r0-logs',
    busyGuard: null,
    measure: ['/home/ci/actions-runner/a/_diag'],
    actions: [{ kind: 'oldLogs', path: '/home/ci/actions-runner/a/_diag', days: 7 }],
  },
  {
    id: 'docker-build',
    busyGuard: null,
    measure: [],
    actions: [{ kind: 'docker', prune: 'buildCache' }],
  },
  {
    id: 'cache-npm',
    busyGuard: null,
    measure: ['/home/ci/.npm/_cacache'],
    actions: [
      {
        kind: 'toolCommand',
        tool: 'npm',
        args: ['cache', 'clean', '--force'],
        fallback: '/home/ci/.npm/_cacache',
      },
    ],
  },
  {
    id: 'gone-0',
    busyGuard: '/opt/old',
    measure: ['/opt/old'],
    actions: [{ kind: 'removeRunner', path: '/opt/old' }],
  },
];

describe('posixCleanScript', () => {
  const script = posixCleanScript(steps);

  it('quotes every path', () => {
    expect(script).toContain("rv_rm '/home/ci/actions-runner/a/_work/web'");
    expect(script).toContain("rv_rm '/home/ci/it'\\''s'");
    expect(script).toContain("rv_oldlogs '/home/ci/actions-runner/a/_diag' 7");
  });

  it('skips a runner folder while a job runs from it', () => {
    expect(script).toContain("if rv_busy '/home/ci/actions-runner/a'; then");
    expect(script).toContain('@@skip');
  });

  it('prints one answer per item', () => {
    for (const step of steps) expect(script).toContain(`RV_ID='${step.id}'`);
    expect(script).toContain('rv_out @@done "$RV_ID"');
    expect(script).toContain('rv_out @@donehuman "$RV_ID"');
    expect(script).toContain('rv_out @@fail "$RV_ID"');
  });

  it('runs the tool command when it is there and empties the folder when not', () => {
    expect(script).toContain("if command -v 'npm' >/dev/null 2>&1; then");
    expect(script).toContain("'npm' 'cache' 'clean' '--force'");
    expect(script).toContain("rv_empty '/home/ci/.npm/_cacache'");
  });

  it('prunes Docker with the right command and removes a runner with its service', () => {
    expect(script).toContain("rv_docker_prune 'builder prune -f'");
    expect(script).toContain("rv_unservice '/opt/old' && rv_rm '/opt/old'");
  });
});

describe('posixJobScript', () => {
  it('carries its settings, takes a lock and logs each run', () => {
    const script = posixJobScript(DEFAULT_SCHEDULE);
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain(`${CONFIG_PREFIX}${JSON.stringify(DEFAULT_SCHEDULE)}`);
    expect(script).toContain('runner-cleanup.lock');
    expect(script).toContain('runner-cleanup.log');
    expect(script).toContain('tail -n 200');
  });

  it('only has the commands for the rules that are on', () => {
    const all = posixJobScript({
      ...DEFAULT_SCHEDULE,
      rules: {
        temp: true,
        actions: true,
        oldVersions: true,
        toolKeepNewest: true,
        logsOlderThanDays: 14,
        checkoutsOlderThanDays: 5,
        dockerOlderThanHours: 48,
        packageCaches: true,
      },
    });
    expect(all).toContain('rv_empty "$rv_d/_work/_temp"');
    expect(all).toContain('rv_rm "$rv_d/_work/_actions"');
    expect(all).toContain('rv_oldlogs "$rv_d/_diag" 14');
    expect(all).toContain('-mtime -5');
    expect(all).toContain('until=48h');
    // Old versions go straight from the glob to rv_rm, never through a list read line by line.
    expect(all).toContain('rv_oldversions "$rv_d" rv_rm');
    expect(all).not.toMatch(/rv_oldversions[^\n]*\| *while/);
    expect(all).toContain('RV_INSIDE="$rv_d"');
    expect(all).toContain('sort -t. -k1,1n -k2,2n -k3,3n');
    expect(all).toContain("'npm' 'cache' 'clean' '--force'");

    const none = posixJobScript({
      ...DEFAULT_SCHEDULE,
      rules: {
        temp: false,
        actions: false,
        oldVersions: false,
        toolKeepNewest: false,
        logsOlderThanDays: null,
        checkoutsOlderThanDays: null,
        dockerOlderThanHours: null,
        packageCaches: false,
      },
    });
    expect(none).not.toContain('_work/_temp');
    expect(none).not.toContain('until=');
    expect(none).not.toContain("'npm' 'cache'");
  });
});

describe('posixInstallScript', () => {
  it('writes the job script and puts a marked block in the crontab on Linux', () => {
    const script = posixInstallScript(DEFAULT_SCHEDULE, 'linux');
    expect(script).toContain('cat > "$RV_JOBDIR/runner-cleanup.sh" <<\'RUNOVA_JOB_END\'');
    expect(script).toContain('# >>> runova runner cleanup');
    expect(script).toContain('# <<< runova runner cleanup');
    expect(script).toContain('0 3 * * 0 /bin/sh "$HOME/.runova/runner-cleanup.sh" >/dev/null 2>&1');
    expect(script).toContain('| crontab -');
    expect(script).toContain("printf '@@error\\tnocron\\n'");
  });

  it('writes a LaunchAgent and loads it on macOS', () => {
    const script = posixInstallScript(DEFAULT_SCHEDULE, 'macos');
    expect(script).toContain('Library/LaunchAgents/com.runova.runner-cleanup.plist');
    expect(script).toContain('launchctl bootstrap "gui/$RV_UID"');
    expect(script).toContain('launchctl load -w');
    expect(script).toContain('<string>${HOME}/.runova/runner-cleanup.sh</string>');
    expect(script).not.toContain('crontab');
  });
});

describe('posixRemoveScript', () => {
  it('takes the block out of the crontab on Linux and unloads the agent on macOS', () => {
    expect(posixRemoveScript('linux')).toContain('crontab -');
    expect(posixRemoveScript('linux')).toContain('rm -f "$HOME/.runova/runner-cleanup.sh"');
    expect(posixRemoveScript('macos')).toContain('launchctl bootout');
  });
});

describe('posixInstallAnyScript and posixRemoveAnyScript', () => {
  it('say which OS they ran on and branch on uname', () => {
    for (const script of [posixInstallAnyScript(DEFAULT_SCHEDULE), posixRemoveAnyScript()]) {
      expect(script).toContain(`printf 'os\t%s\n' "$(uname -s)"`);
      expect(script).toContain('if [ "$(uname -s)" = Darwin ]; then');
      expect(script).toContain('launchctl');
      expect(script).toContain('crontab');
    }
  });
});
