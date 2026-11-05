import type {
  CleanupCandidate,
  CleanupLocation,
  CleanupStudioVideo,
  ProjectCleanupScan,
} from '@shared/projectCleanupTypes';
import { describe, expect, it } from 'vitest';
import {
  composition,
  defaultSelection,
  groupRows,
  presetSelection,
  reclaimableBytes,
  restoreCommands,
  rowsFromScan,
  selectionTotals,
  summarize,
  toggleGroup,
  toRemoveItems,
  withoutRemoved,
} from './selection';

function candidate(over: Partial<CleanupCandidate> = {}): CleanupCandidate {
  const relPath = over.relPath ?? 'node_modules';
  const locationId = over.locationId ?? 'main';
  return {
    id: `${locationId}:${relPath}`,
    locationId,
    relPath,
    name: relPath.split('/').at(-1) ?? relPath,
    category: 'dependencies',
    bytes: 1000,
    sharedBytes: 0,
    files: 10,
    modifiedAt: 1_700_000_000_000,
    restore: { label: 'Comes back when you reinstall the dependencies.', command: 'pnpm install' },
    locked: null,
    ...over,
  };
}

function location(over: Partial<CleanupLocation> = {}): CleanupLocation {
  return {
    id: 'main',
    label: 'Project folder',
    path: 'C:/work/shop',
    branch: null,
    isMain: true,
    totalBytes: 10_000,
    gitBytes: 500,
    candidates: [],
    unreadable: 0,
    ...over,
  };
}

function video(over: Partial<CleanupStudioVideo> = {}): CleanupStudioVideo {
  return { videoId: 'v1', title: 'Launch film', bytes: 700, busy: false, ...over };
}

function scanOf(over: Partial<ProjectCleanupScan> = {}): ProjectCleanupScan {
  return { projectId: 'p1', scannedAt: 1_700_000_100_000, locations: [], studio: [], ...over };
}

/** A project with one of everything: dependencies, build output, a cache, a Studio video. */
function fullScan(): ProjectCleanupScan {
  return scanOf({
    locations: [
      location({
        totalBytes: 10_000,
        gitBytes: 500,
        candidates: [
          candidate({ relPath: 'node_modules', bytes: 4000, category: 'dependencies' }),
          candidate({
            relPath: 'dist',
            bytes: 1500,
            category: 'build',
            restore: { label: 'Comes back the next time you build the project.', command: null },
          }),
          candidate({
            relPath: '.turbo',
            bytes: 100,
            category: 'cache',
            restore: { label: 'Tools fill it again.', command: null },
          }),
        ],
      }),
    ],
    studio: [video({ bytes: 700 })],
  });
}

describe('rowsFromScan', () => {
  it('turns folders and Studio videos into rows of one shape', () => {
    const rows = rowsFromScan(fullScan());
    expect(rows.map((r) => [r.group, r.name])).toEqual([
      ['dependencies', 'node_modules'],
      ['build', 'dist'],
      ['cache', '.turbo'],
      ['studio', 'Launch film'],
    ]);
    expect(rows[0]).toMatchObject({
      key: 'main:node_modules',
      detail: 'node_modules',
      bytes: 4000,
      freeBytes: 4000,
      item: { kind: 'folder', locationId: 'main', relPath: 'node_modules' },
    });
    expect(rows[3]).toMatchObject({
      key: 'studio:v1',
      group: 'studio',
      bytes: 700,
      files: null,
      item: { kind: 'studio', videoId: 'v1' },
    });
  });

  it('takes away what other names still hold when it says how much deleting frees', () => {
    const scan = scanOf({
      locations: [
        location({
          candidates: [candidate({ bytes: 1000, sharedBytes: 700 })],
        }),
      ],
    });
    const [row] = rowsFromScan(scan);
    expect(row).toMatchObject({ bytes: 1000, sharedBytes: 700, freeBytes: 300 });
  });

  it('names the worktree a folder is in, and leaves the project folder unnamed', () => {
    const scan = scanOf({
      locations: [
        location({ candidates: [candidate({ relPath: 'node_modules' })] }),
        location({
          id: 'wt1',
          label: 'feature/login',
          isMain: false,
          candidates: [candidate({ locationId: 'wt1', relPath: 'node_modules' })],
        }),
      ],
    });
    const rows = rowsFromScan(scan);
    expect(rows.map((r) => r.locationLabel)).toEqual([null, 'feature/login']);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it('locks a Studio video that is rendering', () => {
    const rows = rowsFromScan(scanOf({ studio: [video({ busy: true })] }));
    expect(rows[0]?.locked).toMatch(/render/i);
  });

  it('keeps the reason a folder is locked', () => {
    const scan = scanOf({
      locations: [location({ candidates: [candidate({ locked: 'Deployed with the site.' })] })],
    });
    expect(rowsFromScan(scan)[0]?.locked).toBe('Deployed with the site.');
  });

  it('is empty for a scan with nothing in it', () => {
    expect(rowsFromScan(scanOf())).toEqual([]);
  });
});

describe('groupRows', () => {
  it('orders the groups by how safe they are to clear and skips empty ones', () => {
    const rows = rowsFromScan(fullScan());
    expect(groupRows(rows, new Set()).map((g) => g.id)).toEqual([
      'build',
      'cache',
      'dependencies',
      'studio',
    ]);
    const onlyDeps = rows.filter((r) => r.group === 'dependencies');
    expect(groupRows(onlyDeps, new Set()).map((g) => g.id)).toEqual(['dependencies']);
  });

  it('puts the biggest row first inside a group', () => {
    const scan = scanOf({
      locations: [
        location({
          candidates: [
            candidate({ relPath: 'a/node_modules', bytes: 10 }),
            candidate({ relPath: 'b/node_modules', bytes: 900 }),
            candidate({ relPath: 'c/node_modules', bytes: 50 }),
          ],
        }),
      ],
    });
    const [group] = groupRows(rowsFromScan(scan), new Set());
    expect(group?.rows.map((r) => r.bytes)).toEqual([900, 50, 10]);
  });

  it('adds up each group and says how much of it is picked', () => {
    const rows = rowsFromScan(fullScan());
    const groups = groupRows(rows, new Set(['main:dist']));
    const build = groups.find((g) => g.id === 'build');
    expect(build).toMatchObject({ bytes: 1500, freeBytes: 1500, selectedCount: 1, state: 'all' });
    const deps = groups.find((g) => g.id === 'dependencies');
    expect(deps).toMatchObject({ selectedCount: 0, state: 'none' });
  });

  it('calls a group "some" when only part of it is picked', () => {
    const scan = scanOf({
      locations: [
        location({
          candidates: [
            candidate({ relPath: 'a/node_modules' }),
            candidate({ relPath: 'b/node_modules' }),
          ],
        }),
      ],
    });
    const [group] = groupRows(rowsFromScan(scan), new Set(['main:a/node_modules']));
    expect(group).toMatchObject({ selectedCount: 1, state: 'some', selectedFreeBytes: 1000 });
  });

  it('does not count a locked row when deciding whether a group is all picked', () => {
    const scan = scanOf({
      locations: [
        location({
          candidates: [
            candidate({ relPath: 'a/dist', category: 'build' }),
            candidate({ relPath: 'b/dist', category: 'build', locked: 'Deployed.' }),
          ],
        }),
      ],
    });
    const [group] = groupRows(rowsFromScan(scan), new Set(['main:a/dist']));
    expect(group?.state).toBe('all');
    expect(group?.lockedCount).toBe(1);
  });
});

describe('selection presets', () => {
  it('picks build output, caches and Studio cache by default, and leaves dependencies', () => {
    const rows = rowsFromScan(fullScan());
    expect([...defaultSelection(rows)].sort()).toEqual(['main:.turbo', 'main:dist', 'studio:v1']);
  });

  it('never picks a locked row', () => {
    const scan = scanOf({
      locations: [
        location({
          candidates: [candidate({ relPath: 'dist', category: 'build', locked: 'No.' })],
        }),
      ],
      studio: [video({ busy: true })],
    });
    const rows = rowsFromScan(scan);
    expect(defaultSelection(rows).size).toBe(0);
    expect(presetSelection(rows, 'all').size).toBe(0);
  });

  it('can pick everything that is free to delete, or nothing', () => {
    const rows = rowsFromScan(fullScan());
    expect(presetSelection(rows, 'all').size).toBe(4);
    expect(presetSelection(rows, 'none').size).toBe(0);
    expect([...presetSelection(rows, 'safe')].sort()).toEqual([
      'main:.turbo',
      'main:dist',
      'studio:v1',
    ]);
  });
});

describe('toggleGroup', () => {
  const rows = rowsFromScan(
    scanOf({
      locations: [
        location({
          candidates: [
            candidate({ relPath: 'a/dist', category: 'build' }),
            candidate({ relPath: 'b/dist', category: 'build' }),
            candidate({ relPath: 'c/dist', category: 'build', locked: 'Deployed.' }),
          ],
        }),
      ],
    }),
  );
  const build = rows.filter((r) => r.group === 'build');

  it('picks the whole group when none or only some of it is picked', () => {
    expect([...toggleGroup(build, new Set())].sort()).toEqual(['main:a/dist', 'main:b/dist']);
    expect([...toggleGroup(build, new Set(['main:a/dist']))].sort()).toEqual([
      'main:a/dist',
      'main:b/dist',
    ]);
  });

  it('clears the group when all of it is picked, and leaves other picks alone', () => {
    const next = toggleGroup(build, new Set(['main:a/dist', 'main:b/dist', 'main:elsewhere']));
    expect([...next]).toEqual(['main:elsewhere']);
  });

  it('does not change the set it was given', () => {
    const before = new Set(['main:a/dist']);
    toggleGroup(build, before);
    expect([...before]).toEqual(['main:a/dist']);
  });
});

describe('selectionTotals', () => {
  it('counts what is picked and how much that frees', () => {
    const rows = rowsFromScan(fullScan());
    expect(selectionTotals(rows, new Set(['main:dist', 'studio:v1']))).toEqual({
      count: 2,
      freeBytes: 2200,
    });
  });

  it('ignores keys that are no longer in the list', () => {
    const rows = rowsFromScan(fullScan());
    expect(selectionTotals(rows, new Set(['main:gone']))).toEqual({ count: 0, freeBytes: 0 });
  });

  it('does not count a locked row even if it is in the set', () => {
    const rows = rowsFromScan(
      scanOf({
        locations: [location({ candidates: [candidate({ locked: 'No.' })] })],
      }),
    );
    expect(selectionTotals(rows, new Set(['main:node_modules']))).toEqual({
      count: 0,
      freeBytes: 0,
    });
  });
});

describe('restoreCommands', () => {
  it('lists each command once, in the order the rows were picked from', () => {
    const scan = scanOf({
      locations: [
        location({
          candidates: [
            candidate({ relPath: 'a/node_modules', bytes: 30 }),
            candidate({ relPath: 'b/node_modules', bytes: 20 }),
            candidate({
              relPath: 'Pods',
              bytes: 10,
              restore: { label: 'Pods.', command: 'pod install' },
            }),
          ],
        }),
      ],
    });
    const rows = rowsFromScan(scan);
    const all = new Set(rows.map((r) => r.key));
    expect(restoreCommands(rows, all)).toEqual(['pnpm install', 'pod install']);
  });

  it('has none for output and caches', () => {
    const rows = rowsFromScan(fullScan());
    expect(restoreCommands(rows, new Set(['main:dist', 'main:.turbo']))).toEqual([]);
  });
});

describe('toRemoveItems', () => {
  it('names the picked rows the way the main process wants them', () => {
    const rows = rowsFromScan(fullScan());
    expect(toRemoveItems(rows, new Set(['main:dist', 'studio:v1']))).toEqual([
      { kind: 'folder', locationId: 'main', relPath: 'dist' },
      { kind: 'studio', videoId: 'v1' },
    ]);
  });

  it('leaves out locked rows', () => {
    const rows = rowsFromScan(
      scanOf({ locations: [location({ candidates: [candidate({ locked: 'No.' })] })] }),
    );
    expect(toRemoveItems(rows, new Set(['main:node_modules']))).toEqual([]);
  });
});

describe('composition', () => {
  it('splits the space into your files, git history, and each kind of weight', () => {
    const parts = composition(fullScan());
    expect(parts.map((p) => [p.id, p.bytes])).toEqual([
      ['own', 3900],
      ['git', 500],
      ['dependencies', 4000],
      ['build', 1500],
      ['cache', 100],
      ['studio', 700],
    ]);
  });

  it('drops the parts that are empty', () => {
    const parts = composition(scanOf({ locations: [location({ totalBytes: 800, gitBytes: 0 })] }));
    expect(parts.map((p) => p.id)).toEqual(['own']);
  });

  it('never reports a negative amount of your own files', () => {
    const parts = composition(
      scanOf({
        locations: [
          location({
            totalBytes: 100,
            gitBytes: 50,
            candidates: [candidate({ bytes: 500 })],
          }),
        ],
      }),
    );
    expect(parts.every((p) => p.bytes >= 0)).toBe(true);
  });

  it('adds up several locations', () => {
    const scan = scanOf({
      locations: [
        location({ totalBytes: 1000, gitBytes: 100 }),
        location({ id: 'wt1', isMain: false, totalBytes: 2000, gitBytes: 0 }),
      ],
    });
    expect(composition(scan).find((p) => p.id === 'own')?.bytes).toBe(2900);
  });
});

describe('summarize and reclaimableBytes', () => {
  it('says how much the project uses, with Studio cache, and how much of it could go', () => {
    const summary = summarize(fullScan());
    expect(summary).toEqual({
      scannedAt: 1_700_000_100_000,
      totalBytes: 10_700,
      reclaimableBytes: 4000 + 1500 + 100 + 700,
    });
  });

  it('leaves locked rows out of what could go', () => {
    const scan = scanOf({
      locations: [
        location({
          candidates: [
            candidate({ bytes: 300, locked: 'No.' }),
            candidate({ relPath: 'dist', bytes: 40 }),
          ],
        }),
      ],
    });
    expect(reclaimableBytes(scan)).toBe(40);
  });
});

describe('withoutRemoved', () => {
  it('drops the folders and videos that were deleted and takes their size off the totals', () => {
    const scan = fullScan();
    const next = withoutRemoved(scan, new Set(['main:dist', 'studio:v1']));
    const [main] = next.locations;
    expect(main?.candidates.map((c) => c.relPath)).toEqual(['node_modules', '.turbo']);
    expect(main?.totalBytes).toBe(10_000 - 1500);
    expect(next.studio).toEqual([]);
  });

  it('does not change the scan it was given', () => {
    const scan = fullScan();
    withoutRemoved(scan, new Set(['main:dist']));
    expect(scan.locations[0]?.candidates).toHaveLength(3);
  });

  it('is the same scan when nothing was removed', () => {
    const scan = fullScan();
    expect(withoutRemoved(scan, new Set())).toEqual(scan);
  });
});
