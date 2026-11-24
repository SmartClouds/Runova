import type { CloneJob } from '@shared/apiTypes';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { installRunovaBridge } from '../../../test/renderer/runovaBridge';
import {
  cancelClone,
  dismissClone,
  initCloneJobs,
  startClone,
  useCloneJobForProject,
  useCloneJobsStore,
} from './cloneJobsStore';

function job(overrides: Partial<CloneJob> = {}): CloneJob {
  return {
    id: 'j1',
    projectId: 'p1',
    projectName: 'My app',
    repoUrl: 'https://github.com/acme/my-app',
    repoLabel: 'acme/my-app',
    folderPath: 'C:/code/my-app',
    attach: false,
    status: 'running',
    phase: null,
    percent: 0,
    startedAt: 0,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('cloneJobsStore', () => {
  it('loads the jobs main already has and follows every update after', async () => {
    const bridge = installRunovaBridge({ 'git.cloneJobs': [job({ percent: 30 })] });

    const stop = initCloneJobs();
    await flush();
    expect(useCloneJobsStore.getState().jobs).toEqual([job({ percent: 30 })]);

    bridge.$emit('git.onCloneJobs', [job({ percent: 60 })]);
    expect(useCloneJobsStore.getState().jobs[0]?.percent).toBe(60);

    stop();
    expect(bridge.$listenerCount('git.onCloneJobs')).toBe(0);
  });

  it('keeps a live update when the first load answers late', async () => {
    let answer: (jobs: CloneJob[]) => void = () => undefined;
    const bridge = installRunovaBridge({
      'git.cloneJobs': () => new Promise<CloneJob[]>((resolve) => (answer = resolve)),
    });

    initCloneJobs();
    bridge.$emit('git.onCloneJobs', [job({ percent: 80 })]);
    answer([job({ percent: 10 })]);
    await flush();

    expect(useCloneJobsStore.getState().jobs[0]?.percent).toBe(80);
  });

  it('copes with a main that has nothing to say', async () => {
    installRunovaBridge({ 'git.cloneJobs': async () => undefined });
    initCloneJobs();
    await flush();
    expect(useCloneJobsStore.getState().jobs).toEqual([]);
  });

  it('shows a started job before main announces it', async () => {
    const bridge = installRunovaBridge({
      'git.startClone': { ok: true, message: 'Cloning.', job: job() },
    });

    const result = await startClone({ projectId: 'p1' });

    expect(result.ok).toBe(true);
    expect(bridge.$fn('git.startClone')).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(useCloneJobsStore.getState().jobs).toEqual([job()]);
  });

  it('turns a failed call into a result rather than a throw', async () => {
    installRunovaBridge({
      'git.startClone': () => Promise.reject(new Error('IPC went away')),
    });

    expect(await startClone({ projectId: 'p1' })).toEqual({
      ok: false,
      message: 'IPC went away',
    });
  });

  it('asks main to stop a job, and to forget a finished one at once', async () => {
    const bridge = installRunovaBridge({
      'git.cancelClone': async () => true,
      'git.dismissClone': async () => true,
    });
    useCloneJobsStore.getState().setJobs([job({ status: 'failed' })]);

    await cancelClone('j1');
    expect(bridge.$fn('git.cancelClone')).toHaveBeenCalledWith('j1');

    const dismissing = dismissClone('j1');
    expect(useCloneJobsStore.getState().jobs).toEqual([]);
    await dismissing;
    expect(bridge.$fn('git.dismissClone')).toHaveBeenCalledWith('j1');
  });

  it('counts the cards that show a job, so a toast can stay out of the way', () => {
    const { showCard } = useCloneJobsStore.getState();
    const hideA = showCard('j1');
    const hideB = showCard('j1');
    expect(useCloneJobsStore.getState().visible.j1).toBe(2);

    hideA();
    hideB();
    expect(useCloneJobsStore.getState().visible.j1).toBeUndefined();
  });

  it('finds the job of a project', () => {
    installRunovaBridge();
    useCloneJobsStore.getState().setJobs([job(), job({ id: 'j2', projectId: 'p2' })]);

    const { result } = renderHook(() => useCloneJobForProject('p2'));
    expect(result.current?.id).toBe('j2');

    const none = renderHook(() => useCloneJobForProject('p3'));
    expect(none.result.current).toBeUndefined();
  });
});
