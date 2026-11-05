import type { ProjectCleanupScan } from '@shared/projectCleanupTypes';
import { describe, expect, it, vi } from 'vitest';
import { useProjectCleanupStore } from '@/stores/projectCleanupStore';
import { installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import { scanAllProjects } from './scanAll';

function scanFor(projectId: string): ProjectCleanupScan {
  return {
    projectId,
    scannedAt: 1,
    studio: [],
    locations: [
      {
        id: 'main',
        label: 'Project folder',
        path: `C:/${projectId}`,
        branch: null,
        isMain: true,
        totalBytes: 100,
        gitBytes: 0,
        unreadable: 0,
        candidates: [],
      },
    ],
  };
}

describe('scanAllProjects', () => {
  it('scans the projects one after another and remembers each result', async () => {
    const order: string[] = [];
    installRunovaBridge({
      'projectCleanup.scan': async (projectId: string) => {
        order.push(`start ${projectId}`);
        await Promise.resolve();
        order.push(`end ${projectId}`);
        return scanFor(projectId);
      },
    });
    const outcome = await scanAllProjects(['a', 'b', 'c']);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(outcome).toEqual({ done: 3, failed: 0, cancelled: false });
    expect(Object.keys(useProjectCleanupStore.getState().summaries).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('shows how far along it is while it works', async () => {
    const seen: { done: number; current: string | null }[] = [];
    installRunovaBridge({
      'projectCleanup.scan': async (projectId: string) => {
        const { done, current } = useProjectCleanupStore.getState().bulk;
        seen.push({ done, current });
        return scanFor(projectId);
      },
    });
    await scanAllProjects(['a', 'b']);
    expect(seen).toEqual([
      { done: 0, current: 'a' },
      { done: 1, current: 'b' },
    ]);
  });

  it('is idle again afterwards', async () => {
    installRunovaBridge({ 'projectCleanup.scan': async (id: string) => scanFor(id) });
    await scanAllProjects(['a']);
    expect(useProjectCleanupStore.getState().bulk.running).toBe(false);
  });

  it('carries on past a project that cannot be scanned, and counts it', async () => {
    installRunovaBridge({
      'projectCleanup.scan': async (projectId: string) => {
        if (projectId === 'b') throw new Error('That project no longer exists.');
        return scanFor(projectId);
      },
    });
    const outcome = await scanAllProjects(['a', 'b', 'c']);
    expect(outcome).toEqual({ done: 3, failed: 1, cancelled: false });
    expect(Object.keys(useProjectCleanupStore.getState().summaries).sort()).toEqual(['a', 'c']);
  });

  it('stops when told to, without scanning the rest', async () => {
    const controller = new AbortController();
    const scan = vi.fn(async (projectId: string) => {
      if (projectId === 'a') controller.abort();
      return scanFor(projectId);
    });
    installRunovaBridge({
      'projectCleanup.scan': scan,
      'projectCleanup.cancel': async () => true,
    });
    const outcome = await scanAllProjects(['a', 'b', 'c'], { signal: controller.signal });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(outcome.cancelled).toBe(true);
    expect(useProjectCleanupStore.getState().bulk.running).toBe(false);
  });

  it('does not start a second run while one is going', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scan = vi.fn(async (projectId: string) => {
      await held;
      return scanFor(projectId);
    });
    installRunovaBridge({ 'projectCleanup.scan': scan });
    const first = scanAllProjects(['a']);
    await vi.waitFor(() => expect(scan).toHaveBeenCalled());
    const second = await scanAllProjects(['b']);
    expect(second).toEqual({ done: 0, failed: 0, cancelled: false });
    release();
    await first;
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an empty list', async () => {
    installRunovaBridge();
    expect(await scanAllProjects([])).toEqual({ done: 0, failed: 0, cancelled: false });
    expect(useProjectCleanupStore.getState().bulk.running).toBe(false);
  });
});
