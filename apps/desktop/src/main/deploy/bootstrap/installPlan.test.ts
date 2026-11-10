import { describe, expect, it } from 'vitest';
import {
  CHECKSUM_MISMATCH_EXIT,
  CORE_ROOT,
  type InstallPlanInput,
  installSteps,
  releaseDirectory,
  rollbackSteps,
  uninstallSteps,
} from './installPlan';

/**
 * The exact root commands that install the core, as plain data, so their order and quoting are
 * pinned here rather than discovered on a customer's server. The download is copied into a
 * root-only folder and checked against its published SHA-256 before anything unpacks it.
 */

const SHA = 'ab'.repeat(32);

function input(overrides: Partial<InstallPlanInput> = {}): InstallPlanInput {
  return {
    version: '1.53.0',
    sha256: SHA,
    file: 'runova-core-1.53.0-linux-x64.tar.gz',
    stagingFile: '/tmp/runova.Ab12Cd34/runova-core-1.53.0-linux-x64.tar.gz',
    loginUser: 'deployer',
    rootLogin: false,
    selinux: false,
    previousRelease: null,
    ...overrides,
  };
}

function commands(steps: ReturnType<typeof installSteps>): string {
  return steps.map((step) => step.command).join('\n');
}

describe('releaseDirectory', () => {
  it('names a release by version and content, so two dev builds never collide', () => {
    expect(releaseDirectory('0.0.0-dev', SHA)).toBe(`${CORE_ROOT}/releases/0.0.0-dev-abababababab`);
    expect(releaseDirectory('0.0.0-dev', 'cd'.repeat(32))).not.toBe(
      releaseDirectory('0.0.0-dev', SHA),
    );
  });

  it('refuses a version that is not a plain version string', () => {
    expect(() => releaseDirectory('1.0; rm -rf /', SHA)).toThrow(/version/);
    expect(() => releaseDirectory('1.0', 'not-a-hash')).toThrow(/SHA-256/);
  });
});

describe('installSteps', () => {
  it('checks the download before it is ever unpacked', () => {
    const steps = installSteps(input());
    const ids = steps.map((step) => step.id);

    expect(ids.indexOf('verify')).toBeLessThan(ids.indexOf('extract'));
    const verify = steps.find((step) => step.id === 'verify')?.command ?? '';
    expect(verify).toContain(`install -d -m 0700 ${CORE_ROOT}/incoming`);
    expect(verify).toContain(`sha256sum -c --status`);
    expect(verify).toContain(SHA);
  });

  it('exits with its own code when the checksum is wrong, so a copy failure reads differently', () => {
    const verify = installSteps(input()).find((step) => step.id === 'verify')?.command ?? '';

    expect(verify.endsWith(`sha256sum -c --status || exit ${CHECKSUM_MISMATCH_EXIT}; }`)).toBe(
      true,
    );
  });

  it('never unpacks the download from a folder the login user can write to', () => {
    const extract = installSteps(input()).find((step) => step.id === 'extract')?.command ?? '';

    expect(extract).toContain(`${CORE_ROOT}/incoming/runova-core-1.53.0-linux-x64.tar.gz`);
    expect(extract).not.toContain('/tmp/');
    expect(extract).toContain('--no-same-owner');
    expect(extract).toContain('chown -R root:root');
  });

  it('adds a non-root login to the runova group so it can reach the socket', () => {
    const group = installSteps(input()).find((step) => step.id === 'group')?.command ?? '';

    expect(group).toContain('groupadd --system runova');
    expect(group).toContain('usermod -aG runova deployer');
  });

  it('leaves group membership alone for a root login', () => {
    expect(commands(installSteps(input({ rootLogin: true })))).not.toContain('usermod');
  });

  it('quotes a login name it did not choose', () => {
    expect(commands(installSteps(input({ loginUser: "o'brien" })))).toContain(
      `usermod -aG runova 'o'\\''brien'`,
    );
  });

  it('relabels files for SELinux only where SELinux is on', () => {
    expect(commands(installSteps(input({ selinux: true })))).toContain(
      `restorecon -R ${CORE_ROOT}`,
    );
    expect(commands(installSteps(input()))).not.toContain('restorecon');
  });

  it('switches releases atomically and then restarts the service', () => {
    const steps = installSteps(input());
    const ids = steps.map((step) => step.id);
    const release = releaseDirectory('1.53.0', SHA);

    expect(ids).toEqual(['verify', 'group', 'extract', 'unit', 'switch', 'start', 'cleanup']);
    expect(steps.find((step) => step.id === 'switch')?.command).toBe(
      `ln -sfn ${release} ${CORE_ROOT}/current.new && mv -Tf ${CORE_ROOT}/current.new ${CORE_ROOT}/current`,
    );
    expect(steps.find((step) => step.id === 'start')?.command).toContain(
      'systemctl restart runova-core',
    );
  });

  it('keeps the previous release when cleaning up', () => {
    const cleanup =
      installSteps(input({ previousRelease: `${CORE_ROOT}/releases/1.52.0-cdcdcdcdcdcd` })).find(
        (step) => step.id === 'cleanup',
      )?.command ?? '';

    expect(cleanup).toContain('1.52.0-cdcdcdcdcdcd');
    expect(cleanup).toContain('1.53.0-abababababab');
    expect(cleanup).toContain(`rm -rf ${CORE_ROOT}/incoming`);
  });

  it('refuses a previous release outside the releases folder', () => {
    expect(() => installSteps(input({ previousRelease: '/etc' }))).toThrow(/release/);
    expect(() =>
      installSteps(input({ previousRelease: `${CORE_ROOT}/releases/../../etc` })),
    ).toThrow(/release/);
  });

  it('gives every step a title a person can follow', () => {
    for (const step of installSteps(input({ selinux: true }))) {
      // A capitalized phrase, not a sentence: no trailing period.
      expect(step.title).toMatch(/^[A-Z].*[^.]$/);
    }
  });
});

describe('rollbackSteps', () => {
  it('points current back at the previous release and restarts it', () => {
    const previous = `${CORE_ROOT}/releases/1.52.0-cdcdcdcdcdcd`;

    const rollback = rollbackSteps(previous)
      .map((step) => step.command)
      .join('\n');

    expect(rollback).toContain(`ln -sfn ${previous} ${CORE_ROOT}/current.new`);
    expect(rollback).toContain(`install -m 0644 -o root -g root ${previous}/runova-core.service`);
    expect(rollback).toContain('systemctl restart runova-core');
  });

  it('refuses a previous release outside the releases folder', () => {
    expect(() => rollbackSteps('/etc')).toThrow(/release/);
  });
});

describe('uninstallSteps', () => {
  it('removes the service and program but keeps data unless asked', () => {
    const kept = uninstallSteps({ keepData: true })
      .map((step) => step.command)
      .join('\n');
    const removed = uninstallSteps({ keepData: false })
      .map((step) => step.command)
      .join('\n');

    expect(kept).toContain('systemctl disable --now runova-core');
    expect(kept).toContain(`rm -rf ${CORE_ROOT}`);
    expect(kept).not.toContain('/var/lib/runova-core');
    expect(removed).toContain('rm -rf /var/lib/runova-core /etc/runova-core');
    expect(removed).toContain('groupdel runova');
    expect(kept).not.toContain('groupdel');
  });
});
