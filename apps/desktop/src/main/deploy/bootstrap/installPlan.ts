import { quoteForShell } from '@runova/core';
import { RUNOVA_CORE } from '../coreLayout';

/**
 * The root commands that install, roll back and remove the server core, as data. The installer
 * runs them one by one through a root shell and reports each step; nothing here touches a server.
 *
 * Safety rules the order encodes:
 * - The download is copied into a folder only root can write to and checked against its
 *   published SHA-256 there, before anything unpacks it. Nothing is ever unpacked as root from a
 *   folder the login user could swap files in.
 * - Releases are unpacked beside the running one and switched to with an atomic symlink swap, so
 *   a failed start can go straight back to the previous release.
 */

export const CORE_ROOT = RUNOVA_CORE.root;

export type InstallStepId =
  | 'verify'
  | 'group'
  | 'extract'
  | 'selinux'
  | 'unit'
  | 'switch'
  | 'start'
  | 'cleanup'
  | 'rollback'
  | 'stop'
  | 'remove';

export interface PlanStep {
  id: InstallStepId;
  title: string;
  command: string;
}

export interface InstallPlanInput {
  version: string;
  sha256: string;
  /** The tarball's file name, from the release manifest. */
  file: string;
  /** Where the tarball was uploaded, in a folder the login user owns. */
  stagingFile: string;
  loginUser: string;
  rootLogin: boolean;
  selinux: boolean;
  /** The release `current` pointed at before this install, if any. */
  previousRelease: string | null;
}

/** The verify step's exit code when the download does not match its checksum. */
export const CHECKSUM_MISMATCH_EXIT = 97;

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TARBALL = /^runova-core-[0-9A-Za-z.+-]+-linux-(x64|arm64)\.tar\.gz$/;
const RELEASE_NAME = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;

const q = (value: string): string => quoteForShell(value, 'posix');

/** Whether `path` is a release folder the installer made, and so safe to switch back to. */
export function isReleasePath(path: string): boolean {
  const { releases } = RUNOVA_CORE;
  return path.startsWith(`${releases}/`) && RELEASE_NAME.test(path.slice(releases.length + 1));
}

function assertReleasePath(path: string): void {
  if (!isReleasePath(path)) throw new Error(`${path} is not a server core release.`);
}

export function releaseDirectory(version: string, sha256: string): string {
  if (!VERSION.test(version)) throw new Error(`"${version}" is not a release version.`);
  if (!SHA256.test(sha256)) throw new Error('The release checksum is not a SHA-256.');
  return `${RUNOVA_CORE.releases}/${version}-${sha256.slice(0, 12)}`;
}

export function installSteps(input: InstallPlanInput): PlanStep[] {
  if (!TARBALL.test(input.file))
    throw new Error(`"${input.file}" is not a server core release file.`);
  const names = RUNOVA_CORE;
  const { root: coreRoot, releases, current, unitPath: unit } = names;
  const incoming = `${coreRoot}/incoming`;
  if (input.previousRelease !== null) assertReleasePath(input.previousRelease);
  const release = releaseDirectory(input.version, input.sha256);
  const incomingFile = `${incoming}/${input.file}`;
  const unpack = `${release}.new`;

  const steps: PlanStep[] = [
    {
      id: 'verify',
      title: 'Check the download against its published checksum',
      command: [
        `install -d -m 0755 -o root -g root ${coreRoot}`,
        `rm -rf ${incoming}`,
        `install -d -m 0700 ${incoming}`,
        `cp -- ${q(input.stagingFile)} ${incomingFile}`,
        `cd ${incoming}`,
        `{ printf '%s  %s\\n' ${input.sha256} ${input.file} | sha256sum -c --status || exit ${CHECKSUM_MISMATCH_EXIT}; }`,
      ].join(' && '),
    },
    {
      id: 'group',
      title: `Create the ${names.group} group`,
      command: [
        `getent group ${names.group} >/dev/null || groupadd --system ${names.group}`,
        ...(input.rootLogin ? [] : [`usermod -aG ${names.group} ${q(input.loginUser)}`]),
      ].join(' && '),
    },
    {
      id: 'extract',
      title: `Unpack release ${input.version}`,
      command: [
        `install -d -m 0755 ${releases}`,
        `rm -rf ${unpack}`,
        `install -d -m 0755 ${unpack}`,
        `tar -xzf ${incomingFile} -C ${unpack} --no-same-owner --no-same-permissions`,
        `test -f ${unpack}/${names.binary}`,
        `test -f ${unpack}/${names.unitFile}`,
        `chown -R root:root ${unpack}`,
        `chmod 0755 ${unpack}/${names.binary}`,
        `chmod 0644 ${unpack}/${names.unitFile}`,
        `rm -rf ${release}`,
        `mv -T ${unpack} ${release}`,
      ].join(' && '),
    },
  ];

  if (input.selinux) {
    steps.push({
      id: 'selinux',
      title: 'Label the files for SELinux',
      command: `restorecon -R ${coreRoot}`,
    });
  }

  const keep = [release, input.previousRelease]
    .filter((value): value is string => Boolean(value))
    .map((path) => path.slice(releases.length + 1));

  steps.push(
    {
      id: 'unit',
      title: 'Install the systemd service',
      command: `install -m 0644 -o root -g root ${release}/${names.unitFile} ${unit} && systemctl daemon-reload`,
    },
    {
      id: 'switch',
      title: `Switch to release ${input.version}`,
      command: `ln -sfn ${release} ${coreRoot}/current.new && mv -Tf ${coreRoot}/current.new ${current}`,
    },
    {
      id: 'start',
      title: 'Start the server core',
      // Type=notify: restart only returns once the core is listening, and fails otherwise.
      command: `systemctl enable ${names.unit} >/dev/null 2>&1; systemctl restart ${names.unit}`,
    },
    {
      id: 'cleanup',
      title: 'Remove the download and older releases',
      command: [
        `rm -rf ${incoming}`,
        `cd ${releases}`,
        `for release in *; do case "$release" in ${keep.map(q).join('|')}) ;; *) rm -rf -- "$release" ;; esac; done`,
      ].join(' && '),
    },
  );
  return steps;
}

export function rollbackSteps(previousRelease: string): PlanStep[] {
  const names = RUNOVA_CORE;
  assertReleasePath(previousRelease);
  const { root: coreRoot, current, unitPath: unit } = names;
  const previous = q(previousRelease);
  return [
    {
      id: 'rollback',
      title: 'Go back to the previous release',
      command: [
        `ln -sfn ${previous} ${coreRoot}/current.new`,
        `mv -Tf ${coreRoot}/current.new ${current}`,
        `install -m 0644 -o root -g root ${previous}/${names.unitFile} ${unit}`,
        'systemctl daemon-reload',
        `systemctl restart ${names.unit}`,
      ].join(' && '),
    },
  ];
}

/** Removes the core, and its data unless `keepData`. */
export function uninstallSteps(options: { keepData: boolean }): PlanStep[] {
  const names = RUNOVA_CORE;
  return [
    {
      id: 'stop',
      title: 'Stop the server core',
      command: `systemctl disable --now ${names.unit} >/dev/null 2>&1 || true; rm -f ${names.unitPath}; systemctl daemon-reload`,
    },
    {
      id: 'remove',
      title: options.keepData
        ? 'Remove the program and keep its data'
        : 'Remove the program and its data',
      command: options.keepData
        ? `rm -rf ${names.root}`
        : [
            `rm -rf ${names.root}`,
            `rm -rf ${names.dataDirectory} ${names.configDirectory}`,
            `{ ! getent group ${names.group} >/dev/null || groupdel ${names.group}; }`,
          ].join(' && '),
    },
  ];
}
