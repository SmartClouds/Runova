import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloneJob } from '../../shared/apiTypes';
import {
  type CloneJobsDeps,
  createCloneJobs,
  PROGRESS_EMIT_MS,
  SUCCESS_LINGER_MS,
} from './cloneJobs';
import type { CloneOutcome, CloneRunOptions } from './cloneRepo';

interface PendingClone {
  folder: string;
  url: string;
  attach: boolean;
  options: CloneRunOptions;
  finish: (outcome: CloneOutcome) => void;
  fail: (error: Error) => void;
}

function setup(overrides: Partial<CloneJobsDeps> = {}) {
  const clones: PendingClone[] = [];
  const broadcasts: CloneJob[][] = [];
  let focused = true;
  let ids = 0;
  const deps: CloneJobsDeps = {
    getProject: vi.fn(async (projectId: string) => ({
      id: projectId,
      name: projectId === 'p2' ? 'Other app' : 'My app',
      folderPath: projectId === 'p2' ? 'C:/code/other' : 'C:/code/my-app',
      repoUrl: 'github.com/acme/my-app',
    })),
    inspectFolder: vi.fn(async () => 'empty' as const),
    clone: vi.fn(
      (folder: string, url: string, attach: boolean, options: CloneRunOptions) =>
        new Promise<CloneOutcome>((resolve, reject) => {
          clones.push({ folder, url, attach, options, finish: resolve, fail: reject });
        }),
    ),
    saveRepoUrl: vi.fn(async () => undefined),
    broadcast: (jobs) => broadcasts.push(jobs.map((job) => ({ ...job }))),
    notify: vi.fn(),
    isAppFocused: () => focused,
    now: () => Date.now(),
    newId: () => `job-${++ids}`,
    ...overrides,
  };
  const jobs = createCloneJobs(deps);
  return {
    jobs,
    deps,
    clones,
    broadcasts,
    last: () => broadcasts.at(-1) ?? [],
    blur: () => {
      focused = false;
    },
  };
}

/** Lets the awaits inside start() and the clone's settle run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-25T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createCloneJobs', () => {
  it('starts a job for the project and tells every window at once', async () => {
    const { jobs, clones, last } = setup();

    const result = await jobs.start({ projectId: 'p1' });

    expect(result).toMatchObject({ ok: true, job: { id: 'job-1', status: 'running' } });
    expect(clones).toHaveLength(1);
    expect(clones[0]).toMatchObject({
      folder: 'C:/code/my-app',
      url: 'https://github.com/acme/my-app',
      attach: false,
    });
    expect(last()).toEqual([
      expect.objectContaining({
        id: 'job-1',
        projectId: 'p1',
        projectName: 'My app',
        repoLabel: 'acme/my-app',
        repoUrl: 'https://github.com/acme/my-app',
        status: 'running',
        phase: null,
        percent: 0,
        startedAt: Date.parse('2026-11-25T10:00:00Z'),
      }),
    ]);
  });

  it('refuses an address that is not a GitHub repo without starting anything', async () => {
    const { jobs, clones } = setup();

    const result = await jobs.start({ projectId: 'p1', repoUrl: 'C:/local/repo' });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/github\.com\/owner\/repo/);
    expect(clones).toHaveLength(0);
  });

  it('skips a folder that is already a repository', async () => {
    const { jobs, clones } = setup({ inspectFolder: vi.fn(async () => 'repo' as const) });

    expect(await jobs.start({ projectId: 'p1' })).toMatchObject({ ok: true, skipped: true });
    expect(clones).toHaveLength(0);
  });

  it('asks before attaching a folder with files, then attaches once confirmed', async () => {
    const { jobs, clones } = setup({ inspectFolder: vi.fn(async () => 'files' as const) });

    const first = await jobs.start({ projectId: 'p1' });
    expect(first).toMatchObject({ ok: false, needsAttachConfirm: true });
    expect(first.job).toBeUndefined();
    expect(clones).toHaveLength(0);

    const second = await jobs.start({ projectId: 'p1', attach: true });
    expect(second).toMatchObject({ ok: true, job: { attach: true } });
    expect(clones[0]?.attach).toBe(true);
  });

  it('hands back the running job instead of cloning the same folder twice', async () => {
    const { jobs, clones } = setup();

    const first = await jobs.start({ projectId: 'p1' });
    const second = await jobs.start({ projectId: 'p1' });

    expect(second.job?.id).toBe(first.job?.id);
    expect(clones).toHaveLength(1);
  });

  it('sends progress at most every few frames, and always the latest', async () => {
    const { jobs, clones, broadcasts, last } = setup();
    await jobs.start({ projectId: 'p1' });
    const before = broadcasts.length;
    const onProgress = clones[0]?.options.onProgress;

    onProgress?.({ phase: 'receiving', percent: 20 });
    onProgress?.({ phase: 'receiving', percent: 30 });
    onProgress?.({ phase: 'receiving', percent: 40, receivedBytes: 2048, bytesPerSecond: 512 });
    expect(broadcasts.length - before).toBeLessThanOrEqual(1);

    vi.advanceTimersByTime(PROGRESS_EMIT_MS);
    expect(last()[0]).toMatchObject({
      phase: 'receiving',
      percent: 40,
      receivedBytes: 2048,
      bytesPerSecond: 512,
    });
    expect(broadcasts.length - before).toBeLessThanOrEqual(2);
  });

  it('reports success right away, saves a typed address, and clears the job after a moment', async () => {
    const { jobs, clones, deps, last } = setup();
    await jobs.start({ projectId: 'p1', repoUrl: 'https://github.com/acme/renamed.git' });

    clones[0]?.finish({ ok: true, mode: 'cloned', message: 'Cloned it.' });
    await flush();

    expect(last()[0]).toMatchObject({ status: 'succeeded', percent: 100, message: 'Cloned it.' });
    expect(last()[0]?.finishedAt).toBe(Date.now());
    expect(deps.saveRepoUrl).toHaveBeenCalledWith('p1', 'https://github.com/acme/renamed');

    vi.advanceTimersByTime(SUCCESS_LINGER_MS);
    expect(last()).toEqual([]);
    expect(jobs.list()).toEqual([]);
  });

  it('does not rewrite the stored address when none was typed', async () => {
    const { jobs, clones, deps } = setup();
    await jobs.start({ projectId: 'p1' });

    clones[0]?.finish({ ok: true, mode: 'cloned', message: 'Cloned it.' });
    await flush();

    expect(deps.saveRepoUrl).not.toHaveBeenCalled();
  });

  it('keeps a failed job, with its reason, until it is dismissed', async () => {
    const { jobs, clones, last } = setup();
    await jobs.start({ projectId: 'p1' });

    clones[0]?.finish({ ok: false, message: 'Repository not found.' });
    await flush();
    vi.advanceTimersByTime(SUCCESS_LINGER_MS * 10);

    expect(last()[0]).toMatchObject({ status: 'failed', message: 'Repository not found.' });
    expect(jobs.dismiss('job-1')).toBe(true);
    expect(last()).toEqual([]);
  });

  it('turns a thrown error into a failed job', async () => {
    const { jobs, clones, last } = setup();
    await jobs.start({ projectId: 'p1' });

    clones[0]?.fail(new Error('spawn git ENOENT'));
    await flush();

    expect(last()[0]).toMatchObject({ status: 'failed', message: 'spawn git ENOENT' });
  });

  it('stops a running clone through its signal and marks it cancelled', async () => {
    const { jobs, clones, last } = setup();
    await jobs.start({ projectId: 'p1' });

    expect(jobs.cancel('job-1')).toBe(true);
    expect(clones[0]?.options.signal?.aborted).toBe(true);
    clones[0]?.finish({ ok: false, cancelled: true, message: 'Clone stopped.' });
    await flush();

    expect(last()[0]).toMatchObject({ status: 'cancelled' });
    expect(jobs.cancel('job-1')).toBe(false);
  });

  it('will not dismiss a job that is still running', async () => {
    const { jobs } = setup();
    await jobs.start({ projectId: 'p1' });

    expect(jobs.dismiss('job-1')).toBe(false);
    expect(jobs.list()).toHaveLength(1);
  });

  it('replaces a finished job when the same project is cloned again', async () => {
    const { jobs, clones } = setup();
    await jobs.start({ projectId: 'p1' });
    clones[0]?.finish({ ok: false, message: 'Network down.' });
    await flush();

    await jobs.start({ projectId: 'p1' });

    expect(jobs.list().map((job) => [job.id, job.status])).toEqual([['job-2', 'running']]);
  });

  it('runs clones for different projects side by side', async () => {
    const { jobs, last } = setup();
    await jobs.start({ projectId: 'p1' });
    await jobs.start({ projectId: 'p2' });

    expect(last().map((job) => job.projectName)).toEqual(['My app', 'Other app']);
  });

  it('shows an OS notification only when the app is not in front', async () => {
    const { jobs, clones, deps, blur } = setup();
    await jobs.start({ projectId: 'p1' });
    clones[0]?.finish({ ok: true, mode: 'cloned', message: 'Cloned it.' });
    await flush();
    expect(deps.notify).not.toHaveBeenCalled();

    blur();
    await jobs.start({ projectId: 'p2' });
    clones[1]?.finish({ ok: false, message: 'Repository not found.' });
    await flush();

    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith({
      title: "Couldn't clone Other app",
      body: 'Repository not found.',
      route: '/projects/p2?tab=git',
    });
  });

  it('says nothing to the OS about a clone the user stopped', async () => {
    const { jobs, clones, deps, blur } = setup();
    blur();
    await jobs.start({ projectId: 'p1' });
    jobs.cancel('job-1');
    clones[0]?.finish({ ok: false, cancelled: true, message: 'Clone stopped.' });
    await flush();

    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('names the finished project in a success notification', async () => {
    const { jobs, clones, deps, blur } = setup();
    blur();
    await jobs.start({ projectId: 'p1' });
    clones[0]?.finish({ ok: true, mode: 'cloned', message: 'Cloned it.' });
    await flush();

    expect(deps.notify).toHaveBeenCalledWith({
      title: 'My app is ready',
      body: 'Cloned acme/my-app.',
      route: '/projects/p1?tab=git',
    });
  });
});
