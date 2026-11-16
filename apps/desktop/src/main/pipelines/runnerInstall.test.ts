import { beforeEach, describe, expect, it, vi } from 'vitest';

const gh = vi.hoisted(() => ({
  calls: [] as { path: string; args: string[] }[],
  replies: new Map<string, unknown>(),
  failures: new Map<string, Error>(),
}));

vi.mock('../git/githubCli', () => ({
  ghApi: async (path: string, args: string[] = []) => {
    gh.calls.push({ path, args });
    const failure = gh.failures.get(path);
    if (failure) throw failure;
    if (!gh.replies.has(path)) throw new Error(`no reply for ${path}`);
    return gh.replies.get(path);
  },
  ghErrorMessage: (error: unknown) => (error as Error).message,
}));

const projectRepos = vi.hoisted(() => ({
  list: [] as { owner: string; repo: string; projectId: string; projectName: string }[],
}));

vi.mock('./githubActions', () => ({
  listProjectGithubRepos: async () => projectRepos.list,
}));

import {
  fetchRegistrationToken,
  latestRunnerVersion,
  localRunnerDefaults,
  RUNNER_TOKEN_PLACEHOLDER,
  runnerAssetName,
  runnerInstallDefaults,
  runnerInstallGuide,
  runnerInstallTask,
} from './runnerInstall';

function ghFailure(stderr: string): Error {
  const error = new Error(stderr) as Error & { stderr: string };
  error.stderr = stderr;
  return error;
}

beforeEach(() => {
  gh.calls = [];
  gh.replies.clear();
  gh.failures.clear();
});

describe('fetchRegistrationToken', () => {
  const path = 'repos/acme/web/actions/runners/registration-token';

  it('asks GitHub for a token with a POST and returns it', async () => {
    gh.replies.set(path, { token: 'AABBCC', expires_at: '2026-11-16T04:00:00Z' });
    await expect(fetchRegistrationToken('acme/web')).resolves.toBe('AABBCC');
    expect(gh.calls).toEqual([{ path, args: ['--method', 'POST'] }]);
  });

  it('refuses a repo that is not owner/name without calling GitHub', async () => {
    await expect(fetchRegistrationToken('acme/web; rm -rf /')).rejects.toThrow(/owner\/name/);
    await expect(fetchRegistrationToken('acme')).rejects.toThrow(/owner\/name/);
    expect(gh.calls).toEqual([]);
  });

  it('explains a 403 or 404 as missing admin rights', async () => {
    gh.failures.set(path, ghFailure('gh: Resource not accessible by integration (HTTP 403)'));
    await expect(fetchRegistrationToken('acme/web')).rejects.toThrow(
      'GitHub would not make a runner token for acme/web. Adding a runner needs admin rights on the repo.',
    );
    gh.failures.set(path, ghFailure('gh: Not Found (HTTP 404)'));
    await expect(fetchRegistrationToken('acme/web')).rejects.toThrow(/admin rights/);
  });

  it('explains a 401 as a sign in problem', async () => {
    gh.failures.set(path, ghFailure('gh: Bad credentials (HTTP 401)'));
    await expect(fetchRegistrationToken('acme/web')).rejects.toThrow(/gh auth login/);
  });

  it('passes any other failure on with GitHub own words', async () => {
    gh.failures.set(path, ghFailure('error connecting to api.github.com'));
    await expect(fetchRegistrationToken('acme/web')).rejects.toThrow(
      'Could not get a runner token from GitHub: error connecting to api.github.com',
    );
  });

  it('refuses an answer without a token', async () => {
    gh.replies.set(path, { expires_at: 'x' });
    await expect(fetchRegistrationToken('acme/web')).rejects.toThrow(/did not return a token/);
  });
});

describe('latestRunnerVersion', () => {
  it('reads the latest release tag without its v', async () => {
    gh.replies.set('repos/actions/runner/releases/latest', { tag_name: 'v2.329.0' });
    await expect(latestRunnerVersion()).resolves.toBe('2.329.0');
  });

  it('gives null when GitHub cannot be asked, or answers nonsense', async () => {
    gh.failures.set('repos/actions/runner/releases/latest', new Error('offline'));
    await expect(latestRunnerVersion()).resolves.toBeNull();
    gh.failures.clear();
    gh.replies.set('repos/actions/runner/releases/latest', { tag_name: 'nightly; curl evil' });
    await expect(latestRunnerVersion()).resolves.toBeNull();
  });
});

describe('runnerAssetName', () => {
  it('names the package for each OS and CPU the runner ships for', () => {
    expect(runnerAssetName('linux', 'x64', '2.329.0')).toBe(
      'actions-runner-linux-x64-2.329.0.tar.gz',
    );
    expect(runnerAssetName('linux', 'arm', '2.329.0')).toBe(
      'actions-runner-linux-arm-2.329.0.tar.gz',
    );
    expect(runnerAssetName('darwin', 'arm64', '2.329.0')).toBe(
      'actions-runner-osx-arm64-2.329.0.tar.gz',
    );
    expect(runnerAssetName('win32', 'x64', '2.329.0')).toBe('actions-runner-win-x64-2.329.0.zip');
  });

  it('gives null where no package exists', () => {
    expect(runnerAssetName('win32', 'x86', '2.329.0')).toBeNull();
    expect(runnerAssetName('darwin', 'arm', '2.329.0')).toBeNull();
    expect(runnerAssetName('freebsd', 'x64', '2.329.0')).toBeNull();
  });
});

describe('localRunnerDefaults', () => {
  it('names the runner after the host and reports the platform and CPU', () => {
    expect(
      localRunnerDefaults({ hostname: 'Build-PC.local', platform: 'linux', arch: 'x64' }),
    ).toEqual({ name: 'build-pc', platform: 'linux', arch: 'x64', osLabel: 'Linux' });
    expect(
      localRunnerDefaults({ hostname: 'MAC', platform: 'darwin', arch: 'arm64' }).osLabel,
    ).toBe('macOS');
    expect(localRunnerDefaults({ hostname: 'W', platform: 'win32', arch: 'x64' }).osLabel).toBe(
      'Windows',
    );
  });
});

describe('runnerInstallTask', () => {
  it('is one short line for the history, with no token in it', () => {
    expect(runnerInstallTask('box-1', 'acme/web')).toBe(
      'Install a GitHub Actions self-hosted runner called box-1 for acme/web and run it as a service.',
    );
  });
});

describe('runnerInstallGuide', () => {
  const base = { name: 'box-1', repo: 'acme/web', version: '2.329.0' } as const;

  it('uses the placeholder for the token and tells the AI never to show it', () => {
    const guide = runnerInstallGuide({
      ...base,
      machine: { kind: 'local', platform: 'linux', arch: 'x64', homeDir: '/home/me' },
    });
    expect(guide).toContain(`--token ${RUNNER_TOKEN_PLACEHOLDER}`);
    expect(guide).toMatch(/never print, echo, save or ask for the token/i);
    expect(guide).toContain('--url https://github.com/acme/web');
    expect(guide).toContain('--name box-1');
    expect(guide).toContain('--unattended');
  });

  it('gives this computer its exact package, folder and service steps on Linux', () => {
    const guide = runnerInstallGuide({
      ...base,
      machine: { kind: 'local', platform: 'linux', arch: 'x64', homeDir: '/home/me' },
    });
    expect(guide).toContain(
      'https://github.com/actions/runner/releases/download/v2.329.0/actions-runner-linux-x64-2.329.0.tar.gz',
    );
    expect(guide).toContain('/home/me/actions-runner/box-1');
    expect(guide).toContain('sudo ./svc.sh install');
    expect(guide).toContain('./bin/installdependencies.sh');
  });

  it('uses config.cmd, a zip and an administrator service on Windows', () => {
    const guide = runnerInstallGuide({
      ...base,
      machine: { kind: 'local', platform: 'win32', arch: 'x64', homeDir: 'C:\\Users\\me' },
    });
    expect(guide).toContain('actions-runner-win-x64-2.329.0.zip');
    expect(guide).toContain('C:\\Users\\me\\actions-runner\\box-1');
    expect(guide).toContain('config.cmd');
    expect(guide).toContain('--runasservice');
    expect(guide).not.toContain('svc.sh');
  });

  it('uses svc.sh without sudo on macOS', () => {
    const guide = runnerInstallGuide({
      ...base,
      machine: { kind: 'local', platform: 'darwin', arch: 'arm64', homeDir: '/Users/me' },
    });
    expect(guide).toContain('actions-runner-osx-arm64-2.329.0.tar.gz');
    expect(guide).toContain('./svc.sh install');
    expect(guide).not.toContain('sudo ./svc.sh');
  });

  it('has a server work out its own OS and CPU first', () => {
    const guide = runnerInstallGuide({ ...base, machine: { kind: 'ssh' } });
    expect(guide).toContain('uname -sm');
    expect(guide).toContain('~/actions-runner/box-1');
    expect(guide).toContain('actions-runner-<os>-<arch>-2.329.0');
  });

  it('has the AI look the version up when Runova could not', () => {
    const guide = runnerInstallGuide({ ...base, version: null, machine: { kind: 'ssh' } });
    expect(guide).toContain('https://api.github.com/repos/actions/runner/releases/latest');
    expect(guide).not.toContain('null');
  });

  it('only finishes once the service runs, and asks when it lacks the rights', () => {
    const guide = runnerInstallGuide({ ...base, machine: { kind: 'ssh' } });
    expect(guide).toMatch(/FINISHED only once the runner service is running/);
    expect(guide).toMatch(/NEEDS_INPUT/);
  });
});

describe('runnerInstallDefaults', () => {
  it("gives this computer's name, OS and CPU, and the projects' repos without their ids", async () => {
    projectRepos.list = [
      { owner: 'acme', repo: 'web', projectId: 'p1', projectName: 'Web' },
      { owner: 'acme', repo: 'api', projectId: 'p2', projectName: 'API' },
    ];
    await expect(
      runnerInstallDefaults({ hostname: 'Build-PC', platform: 'win32', arch: 'arm64' }),
    ).resolves.toEqual({
      name: 'build-pc',
      osLabel: 'Windows',
      arch: 'arm64',
      repos: [
        { owner: 'acme', repo: 'web', projectName: 'Web' },
        { owner: 'acme', repo: 'api', projectName: 'API' },
      ],
    });
  });

  it('still answers when the repos cannot be read', async () => {
    projectRepos.list = null as unknown as typeof projectRepos.list;
    const defaults = await runnerInstallDefaults({ hostname: 'x', platform: 'linux', arch: 'x64' });
    expect(defaults.repos).toEqual([]);
  });
});
