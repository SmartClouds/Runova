import type { CodeqlInstallProgress } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import type { CancelToken } from '../../process/spawnStreaming';
import type { RunHooks, RunResult } from './packageManagerRunner';
import { createSecurityTools, type SecurityToolsDeps } from './securityTools';

/**
 * The Security stack's own installers: CodeQL's download, the SonarQube container and the Bearer
 * image. Docker and the download are faked; what matters is which command would run, that the
 * container's settings come from its Dev Tools card, and that cancelling is reported as such.
 */

const OK: RunResult = { ok: true, code: 0, cancelled: false };

function hooks() {
  const token: CancelToken = { cancelled: false, child: null };
  const onProgress = vi.fn<RunHooks['onProgress']>();
  const onLine = vi.fn<RunHooks['onLine']>();
  const onCancel = vi.fn<NonNullable<RunHooks['onCancel']>>();
  return { token, onProgress, onLine, onCancel };
}

function progress(
  phase: CodeqlInstallProgress['phase'],
  fraction: number | null,
): CodeqlInstallProgress {
  return {
    phase,
    message: `CodeQL ${phase}`,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    fraction,
  };
}

function tools(overrides: Partial<SecurityToolsDeps> = {}) {
  const deps: SecurityToolsDeps = {
    runArgv: vi.fn(async () => OK),
    containerExists: vi.fn(async () => false),
    installCodeql: vi.fn(async () => undefined),
    cancelCodeql: vi.fn(),
    ...overrides,
  };
  return { deps, security: createSecurityTools(deps) };
}

describe('the SonarQube server', () => {
  it("creates the container from the SonarQube card's settings the first time", async () => {
    const { deps, security } = tools();
    const h = hooks();

    expect(await security.startContainer('sonarqube', h)).toEqual(OK);

    expect(deps.containerExists).toHaveBeenCalledWith('runova-sonarqube');
    expect(deps.runArgv).toHaveBeenCalledWith(
      [
        'docker',
        'run',
        '-d',
        '--name',
        'runova-sonarqube',
        '-p',
        '9000:9000',
        '-v',
        'runova-sonarqube-data:/opt/sonarqube/data',
        '-v',
        'runova-sonarqube-extensions:/opt/sonarqube/extensions',
        '-v',
        'runova-sonarqube-logs:/opt/sonarqube/logs',
        'sonarqube:community',
      ],
      h,
    );
  });

  it('starts the container that is already there, so its data and password are kept', async () => {
    const { deps, security } = tools({ containerExists: vi.fn(async () => true) });
    const h = hooks();

    await security.startContainer('sonarqube', h);

    expect(deps.runArgv).toHaveBeenCalledWith(['docker', 'start', 'runova-sonarqube'], h);
  });

  it('refuses a tool that has no container, without running anything', async () => {
    const { deps, security } = tools();

    expect(await security.startContainer('semgrep', hooks())).toMatchObject({
      ok: false,
      message: 'That tool has no container to start.',
    });
    expect(deps.runArgv).not.toHaveBeenCalled();
  });
});

describe('the Bearer image', () => {
  it('pulls the image it is given', async () => {
    const { deps, security } = tools();
    const h = hooks();

    await security.pullImage('bearer/bearer:latest-amd64', h);

    expect(deps.runArgv).toHaveBeenCalledWith(['docker', 'pull', 'bearer/bearer:latest-amd64'], h);
    expect(h.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'downloading',
        detail: 'Pulling bearer/bearer:latest-amd64',
      }),
    );
  });

  it('does nothing once the run is cancelled', async () => {
    const { deps, security } = tools();
    const h = hooks();
    h.token.cancelled = true;

    expect(await security.pullImage('bearer/bearer:latest-amd64', h)).toMatchObject({
      cancelled: true,
    });
    expect(deps.runArgv).not.toHaveBeenCalled();
  });
});

describe('CodeQL', () => {
  it("passes the download's progress on in Dev Setup's phases", async () => {
    const { security } = tools({
      installCodeql: vi.fn(async (onProgress) => {
        onProgress(progress('resolving', null));
        onProgress(progress('downloading', 0.5));
        onProgress(progress('done', 1));
      }),
    });
    const h = hooks();

    expect(await security.downloadCodeql(h)).toEqual(OK);

    expect(h.onProgress.mock.calls.map(([update]) => update)).toEqual([
      { phase: 'preparing', fraction: null, detail: 'CodeQL resolving' },
      { phase: 'downloading', fraction: 0.5, detail: 'CodeQL downloading' },
    ]);
  });

  it('hands over how to stop the download', async () => {
    const { deps, security } = tools();
    const h = hooks();

    await security.downloadCodeql(h);
    h.onCancel.mock.calls[0]?.[0]();

    expect(deps.cancelCodeql).toHaveBeenCalled();
  });

  it('turns a failed download into a sentence', async () => {
    const { security } = tools({
      installCodeql: vi.fn(async () => {
        throw new Error('The downloaded CodeQL archive did not match the checksum.');
      }),
    });

    expect(await security.downloadCodeql(hooks())).toEqual({
      ok: false,
      code: null,
      cancelled: false,
      message: 'The downloaded CodeQL archive did not match the checksum.',
    });
  });

  it('reports a cancel as a cancel, since a cancelled download resolves instead of throwing', async () => {
    const h = hooks();
    const { security } = tools({
      installCodeql: vi.fn(async () => {
        h.token.cancelled = true;
      }),
    });

    expect(await security.downloadCodeql(h)).toMatchObject({ ok: false, cancelled: true });
  });
});
