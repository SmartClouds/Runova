import os from 'node:os';
import path from 'node:path';
import type { CpuArch, RunnerInstallDefaults } from '../../shared/apiTypes';
import { runnerNameFrom } from '../../shared/runnerName';
import { ghApi, ghErrorMessage } from '../git/githubCli';
import { readCpuArch } from '../system/cpuArch';
import { listProjectGithubRepos } from './githubActions';

/**
 * Adding a GitHub self-hosted runner with the terminal AI (E103). Runova gets the registration
 * token and the facts about the machine; the AI does the install in a terminal the user watches.
 */

/**
 * What the AI writes where the registration token goes. The runner swaps the real token in as it
 * types the command and swaps it back out of everything the AI or the history sees.
 */
export const RUNNER_TOKEN_PLACEHOLDER = '{{RUNOVA_RUNNER_TOKEN}}';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VERSION = /^\d+\.\d+\.\d+$/;

/** A short-lived token that registers one runner on `repo` (`owner/name`). */
export async function fetchRegistrationToken(repo: string): Promise<string> {
  if (!REPO.test(repo)) throw new Error('The repository has to be written as owner/name.');
  let reply: { token?: unknown };
  try {
    reply = await ghApi<{ token?: unknown }>(`repos/${repo}/actions/runners/registration-token`, [
      '--method',
      'POST',
    ]);
  } catch (error) {
    const message = ghErrorMessage(error);
    if (/HTTP 40[34]/.test(message)) {
      throw new Error(
        `GitHub would not make a runner token for ${repo}. Adding a runner needs admin rights on the repo.`,
      );
    }
    if (/HTTP 401/.test(message)) {
      throw new Error('GitHub did not accept the sign in. Run gh auth login and try again.');
    }
    throw new Error(`Could not get a runner token from GitHub: ${message}`);
  }
  if (typeof reply.token !== 'string' || !reply.token) {
    throw new Error('GitHub did not return a token for the runner.');
  }
  return reply.token;
}

/** The newest runner release, such as `2.329.0`, or null when GitHub could not say. */
export async function latestRunnerVersion(): Promise<string | null> {
  try {
    const release = await ghApi<{ tag_name?: unknown }>('repos/actions/runner/releases/latest');
    const tag = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
    return VERSION.test(tag) ? tag : null;
  } catch {
    return null;
  }
}

const ASSET_OS: Partial<Record<string, string>> = { linux: 'linux', darwin: 'osx', win32: 'win' };
const ASSET_ARCHES: Record<string, readonly string[]> = {
  linux: ['x64', 'arm64', 'arm'],
  osx: ['x64', 'arm64'],
  win: ['x64', 'arm64'],
};

/** The release file for this OS and CPU, or null when the runner does not ship one. */
export function runnerAssetName(platform: string, arch: string, version: string): string | null {
  const assetOs = ASSET_OS[platform];
  if (!assetOs || !ASSET_ARCHES[assetOs].includes(arch)) return null;
  return `actions-runner-${assetOs}-${arch}-${version}.${assetOs === 'win' ? 'zip' : 'tar.gz'}`;
}

function osLabelOf(platform: string): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  return 'Linux';
}

export interface LocalRunnerDefaults {
  name: string;
  platform: string;
  arch: CpuArch;
  osLabel: string;
}

/** What this computer gives a new runner: a name from the host name, its OS and CPU. */
export function localRunnerDefaults({
  hostname = os.hostname(),
  platform = process.platform,
  arch = readCpuArch(),
}: {
  hostname?: string;
  platform?: string;
  arch?: CpuArch;
} = {}): LocalRunnerDefaults {
  return { name: runnerNameFrom(hostname), platform, arch, osLabel: osLabelOf(platform) };
}

/** What the Add runner dialog starts from. A failure to read the repos leaves the list empty. */
export async function runnerInstallDefaults(
  machine: { hostname?: string; platform?: string; arch?: CpuArch } = {},
): Promise<RunnerInstallDefaults> {
  const { name, osLabel, arch } = localRunnerDefaults(machine);
  let repos: RunnerInstallDefaults['repos'] = [];
  try {
    repos = (await listProjectGithubRepos()).map(({ owner, repo, projectName }) => ({
      owner,
      repo,
      projectName,
    }));
  } catch {
    // The dialog then asks for the repo instead of offering one.
  }
  return { name, osLabel, arch, repos };
}

/** The task as the terminal's history keeps it: one line, nothing secret. */
export function runnerInstallTask(name: string, repo: string): string {
  return `Install a GitHub Actions self-hosted runner called ${name} for ${repo} and run it as a service.`;
}

export type RunnerMachine =
  | { kind: 'local'; platform: string; arch: string; homeDir: string }
  | { kind: 'ssh' };

export interface RunnerGuideInput {
  name: string;
  repo: string;
  /** The newest runner release, or null to have the AI look it up. */
  version: string | null;
  machine: RunnerMachine;
}

const RELEASES = 'https://github.com/actions/runner/releases/download';

function downloadLine(input: RunnerGuideInput): string {
  const { version, machine } = input;
  const ver = version ?? '<version>';
  const pattern = `${RELEASES}/v${ver}/actions-runner-<os>-<arch>-${ver}.<tar.gz or zip>`;
  const lookUp = version
    ? ''
    : ' Find the newest <version> first from https://api.github.com/repos/actions/runner/releases/latest (its tag_name, without the v).';
  if (machine.kind === 'local' && version) {
    const asset = runnerAssetName(machine.platform, machine.arch, version);
    if (asset) {
      return `- Download ${RELEASES}/v${version}/${asset} into that folder and unpack it there.`;
    }
  }
  const which =
    machine.kind === 'ssh'
      ? 'First check the server OS and CPU with uname -sm, then pick the file that matches'
      : 'Pick the file that matches this computer';
  return `- ${which}: ${pattern}, where <os> is linux, osx or win and <arch> is x64, arm64 or arm (zip on Windows, tar.gz elsewhere). Download it into that folder and unpack it there.${lookUp}`;
}

function folderOf(input: RunnerGuideInput): string {
  const { machine, name } = input;
  if (machine.kind === 'ssh') return `~/actions-runner/${name}`;
  const join = machine.platform === 'win32' ? path.win32.join : path.posix.join;
  return join(machine.homeDir, 'actions-runner', name);
}

function configLines(input: RunnerGuideInput): string[] {
  const { machine, name, repo } = input;
  const flags = `--unattended --url https://github.com/${repo} --token ${RUNNER_TOKEN_PLACEHOLDER} --name ${name} --work _work`;
  if (machine.kind === 'local' && machine.platform === 'win32') {
    return [
      `- Configure it with: .\\config.cmd ${flags} --runasservice`,
      '- --runasservice installs and starts the Windows service, which needs a shell running as administrator. Check that first; if this shell is not elevated, reply NEEDS_INPUT and tell the user to open an administrator terminal, or offer to run it without the service (.\\run.cmd).',
    ];
  }
  const sudo = machine.kind === 'local' && machine.platform === 'darwin' ? '' : 'sudo ';
  const lines = [
    `- Configure it with: ./config.sh ${flags}`,
    `- Then run it as a service so it survives a restart: ${sudo}./svc.sh install, then ${sudo}./svc.sh start.`,
  ];
  if (sudo) {
    lines.push(
      '- On Linux, if config.sh says libraries are missing, run sudo ./bin/installdependencies.sh first.',
    );
  }
  if (machine.kind === 'ssh') {
    lines.push(
      '- If the server turns out to be Windows, use config.cmd with --runasservice instead of config.sh and svc.sh.',
    );
  }
  return lines;
}

function statusCheck(machine: RunnerMachine): string {
  if (machine.kind === 'ssh')
    return 'sudo ./svc.sh status, or Get-Service actions.runner.* on Windows';
  if (machine.platform === 'win32') return 'Get-Service actions.runner.*';
  return machine.platform === 'darwin' ? './svc.sh status' : 'sudo ./svc.sh status';
}

/**
 * The instructions that go in every step's prompt, after the task. The token appears only as the
 * placeholder, so the AI never sees it.
 */
export function runnerInstallGuide(input: RunnerGuideInput): string {
  const { machine, name, repo } = input;
  const where =
    machine.kind === 'local'
      ? `This computer runs ${osLabelOf(machine.platform)} on ${machine.arch}.`
      : 'The server is reached over SSH; do not assume its OS or CPU.';
  return [
    'How to install the runner (Runova prepared this, follow it):',
    `- Runner name: ${name}. Repository: https://github.com/${repo}. ${where}`,
    `- Registration token: write the literal text ${RUNNER_TOKEN_PLACEHOLDER} wherever the token goes. Runova puts the real token in place as it types the command. Never print, echo, save or ask for the token, and never try to get one yourself.`,
    `- Install folder: ${folderOf(input)}. Create it and run every step from inside it.`,
    downloadLine(input),
    ...configLines(input),
    '- Keep the default labels (self-hosted, the OS and the CPU) and the default runner group. Do not add --replace.',
    '- If a step needs rights this shell does not have, reply NEEDS_INPUT and say what the user can do, rather than guessing.',
    `- Reply FINISHED only once the runner service is running (check it with ${statusCheck(machine)}), and say where it is installed.`,
  ].join('\n');
}
