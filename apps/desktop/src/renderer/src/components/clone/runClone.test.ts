import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfirm, useConfirmStore } from '@/stores/confirmStore';
import { installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import { runClone } from './runClone';

const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runClone', () => {
  it('starts the clone and leaves the telling to the job', async () => {
    const bridge = installRunovaBridge({
      'git.startClone': async () => ({ ok: true, message: 'Cloning.', job: { id: 'j1' } }),
    });

    const result = await runClone({ projectId: 'p1' });

    expect(result.ok).toBe(true);
    expect(bridge.$fn('git.startClone')).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('asks before connecting a folder that has files, and connects once the user agrees', async () => {
    const startClone = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, needsAttachConfirm: true, message: 'Has files.' })
      .mockResolvedValueOnce({ ok: true, message: 'Cloning.', job: { id: 'j1' } });
    installRunovaBridge({ 'git.startClone': startClone });

    const running = runClone({ projectId: 'p1', repoUrl: 'github.com/acme/app' });
    await vi.waitFor(() => expect(useConfirmStore.getState().open).toBe(true));
    expect(useConfirmStore.getState().title).toBe('Connect this folder to acme/app?');
    resolveConfirm(true);

    expect((await running).ok).toBe(true);
    expect(startClone).toHaveBeenLastCalledWith({
      projectId: 'p1',
      repoUrl: 'github.com/acme/app',
      attach: true,
    });
  });

  it('does nothing more when the user keeps the folder to itself', async () => {
    const startClone = vi.fn(async () => ({
      ok: false,
      needsAttachConfirm: true,
      message: 'Has files.',
    }));
    installRunovaBridge({ 'git.startClone': startClone });

    const running = runClone({ projectId: 'p1' });
    await vi.waitFor(() => expect(useConfirmStore.getState().open).toBe(true));
    resolveConfirm(false);

    expect((await running).ok).toBe(false);
    expect(startClone).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says why a clone could not start', async () => {
    installRunovaBridge({
      'git.startClone': async () => ({ ok: false, message: 'That address cannot be cloned.' }),
    });

    await runClone({ projectId: 'p1' });

    expect(toast.error).toHaveBeenCalledWith('That address cannot be cloned.');
  });

  it('mentions a folder that was already a repository', async () => {
    installRunovaBridge({
      'git.startClone': async () => ({
        ok: true,
        skipped: true,
        message: 'Folder is already a git repository.',
      }),
    });

    await runClone({ projectId: 'p1' });

    expect(toast.info).toHaveBeenCalledWith('Folder is already a git repository.');
  });
});
