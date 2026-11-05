import type { ProjectCleanupScan } from '@shared/projectCleanupTypes';
import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectCleanupStore } from './projectCleanupStore';

function scanOf(projectId: string, totalBytes: number, candidateBytes: number): ProjectCleanupScan {
  return {
    projectId,
    scannedAt: 1_700_000_000_000,
    studio: [],
    locations: [
      {
        id: 'main',
        label: 'Project folder',
        path: `C:/work/${projectId}`,
        branch: null,
        isMain: true,
        totalBytes,
        gitBytes: 0,
        unreadable: 0,
        candidates: [
          {
            id: 'main:node_modules',
            locationId: 'main',
            relPath: 'node_modules',
            name: 'node_modules',
            category: 'dependencies',
            bytes: candidateBytes,
            sharedBytes: 0,
            files: 3,
            modifiedAt: 0,
            restore: { label: 'x', command: 'npm install' },
            locked: null,
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('projectCleanupStore', () => {
  it('starts with nothing known', () => {
    const state = useProjectCleanupStore.getState();
    expect(state.scans).toEqual({});
    expect(state.summaries).toEqual({});
    expect(state.bulk.running).toBe(false);
  });

  it('keeps a scan and the short summary the Projects page shows', () => {
    useProjectCleanupStore.getState().recordScan('p1', scanOf('p1', 5000, 3000));
    const state = useProjectCleanupStore.getState();
    expect(state.scans.p1?.projectId).toBe('p1');
    expect(state.summaries.p1).toEqual({
      scannedAt: 1_700_000_000_000,
      totalBytes: 5000,
      reclaimableBytes: 3000,
    });
  });

  it("keeps projects apart, and replaces a project's earlier scan", () => {
    const { recordScan } = useProjectCleanupStore.getState();
    recordScan('p1', scanOf('p1', 5000, 3000));
    recordScan('p2', scanOf('p2', 900, 100));
    recordScan('p1', scanOf('p1', 4000, 2000));
    const state = useProjectCleanupStore.getState();
    expect(state.summaries.p1?.totalBytes).toBe(4000);
    expect(state.summaries.p2?.totalBytes).toBe(900);
  });

  it('can drop the full scan and still remember the summary', () => {
    const { recordScan, clearScan } = useProjectCleanupStore.getState();
    recordScan('p1', scanOf('p1', 5000, 3000));
    clearScan('p1');
    const state = useProjectCleanupStore.getState();
    expect(state.scans.p1).toBeUndefined();
    expect(state.summaries.p1?.totalBytes).toBe(5000);
  });

  it('forgets the projects that are no longer there', () => {
    const { recordScan, forgetProjects } = useProjectCleanupStore.getState();
    recordScan('p1', scanOf('p1', 5000, 3000));
    recordScan('p2', scanOf('p2', 900, 100));
    forgetProjects(['p2']);
    const state = useProjectCleanupStore.getState();
    expect(Object.keys(state.summaries)).toEqual(['p2']);
    expect(Object.keys(state.scans)).toEqual(['p2']);
  });

  it('does nothing when every project is still there', () => {
    const { recordScan, forgetProjects } = useProjectCleanupStore.getState();
    recordScan('p1', scanOf('p1', 5000, 3000));
    const before = useProjectCleanupStore.getState().summaries;
    forgetProjects(['p1', 'p2']);
    expect(useProjectCleanupStore.getState().summaries).toBe(before);
  });

  it('writes only the summaries to disk, not the scans with their folder lists', () => {
    useProjectCleanupStore.getState().recordScan('p1', scanOf('p1', 5000, 3000));
    const saved = JSON.parse(localStorage.getItem('runova-project-cleanup') ?? '{}') as {
      state?: Record<string, unknown>;
    };
    expect(Object.keys(saved.state ?? {})).toEqual(['summaries']);
  });

  it('tracks a scan of every project', () => {
    const { beginBulk, stepBulk, endBulk } = useProjectCleanupStore.getState();
    beginBulk(3);
    expect(useProjectCleanupStore.getState().bulk).toMatchObject({
      running: true,
      done: 0,
      total: 3,
      failed: 0,
    });
    stepBulk({ current: 'p1' });
    expect(useProjectCleanupStore.getState().bulk.current).toBe('p1');
    stepBulk({ done: 1 });
    stepBulk({ done: 2, failed: 1 });
    expect(useProjectCleanupStore.getState().bulk).toMatchObject({ done: 2, failed: 1 });
    endBulk();
    expect(useProjectCleanupStore.getState().bulk).toMatchObject({
      running: false,
      done: 0,
      total: 0,
      current: null,
    });
  });
});
