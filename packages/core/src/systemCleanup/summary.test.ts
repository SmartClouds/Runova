import { describe, expect, it } from 'vitest';
import { providerReclaimable, summarizeScan } from './summary.js';
import type { ProviderScan, ScanItem } from './types.js';

let counter = 0;
function scanItem(group: string, version: string | null, bytes: number, sharedBytes = 0): ScanItem {
  counter += 1;
  return {
    id: `s${counter}`,
    group,
    groupLabel: group,
    version,
    bytes,
    sharedBytes,
    files: 3,
    newestMs: 0,
  };
}

function provider(overrides: Partial<ProviderScan> & Pick<ProviderScan, 'id'>): ProviderScan {
  return {
    label: overrides.id,
    tagline: '',
    kind: 'versioned',
    status: 'ready',
    root: '/cache',
    bytes: 0,
    files: 0,
    sharedBytes: 0,
    unreadable: 0,
    items: [],
    clearCommand: null,
    tidyCommand: null,
    afterClearing: '',
    ...overrides,
  };
}

describe('providerReclaimable', () => {
  it('counts the bytes of every version but the newest', () => {
    const scan = provider({
      id: 'nuget',
      items: [scanItem('a', '1.0.0', 100), scanItem('a', '2.0.0', 300), scanItem('b', '1.0.0', 50)],
    });
    expect(providerReclaimable(scan, 1)).toBe(100);
    expect(providerReclaimable(scan, 2)).toBe(0);
  });

  it('leaves out bytes in files that other names point at', () => {
    const scan = provider({
      id: 'bun',
      items: [scanItem('a', '1.0.0', 100, 40), scanItem('a', '2.0.0', 100)],
    });
    expect(providerReclaimable(scan, 1)).toBe(60);
  });

  it('is nothing for a cache that is not ready, or is only cleaned by its tool', () => {
    const items = [scanItem('a', '1.0.0', 100), scanItem('a', '2.0.0', 100)];
    expect(providerReclaimable(provider({ id: 'nuget', status: 'unverified', items }), 1)).toBe(0);
    expect(providerReclaimable(provider({ id: 'nuget', status: 'scanning', items }), 1)).toBe(0);
    expect(providerReclaimable(provider({ id: 'npm', kind: 'opaque', items: [] }), 1)).toBe(0);
  });
});

describe('summarizeScan', () => {
  it('is all zeros when there is nothing', () => {
    expect(summarizeScan([], { keep: 1 })).toEqual({
      totalBytes: 0,
      totalFiles: 0,
      packageCount: 0,
      reclaimableBytes: 0,
      cachesFound: 0,
      parts: [],
    });
  });

  it('adds up the caches and what could be freed from them', () => {
    const summary = summarizeScan(
      [
        provider({
          id: 'nuget',
          bytes: 1000,
          files: 50,
          items: [
            scanItem('a', '1.0.0', 400),
            scanItem('a', '2.0.0', 500),
            scanItem('b', '1.0.0', 100),
          ],
        }),
        provider({ id: 'npm', kind: 'opaque', bytes: 300, files: 20 }),
        provider({ id: 'pip', kind: 'opaque', status: 'missing', bytes: 0 }),
      ],
      { keep: 1 },
    );
    expect(summary).toMatchObject({
      totalBytes: 1300,
      totalFiles: 70,
      packageCount: 2,
      reclaimableBytes: 400,
      cachesFound: 2,
    });
  });

  it('orders the parts of the whole by size and leaves out empty caches', () => {
    const summary = summarizeScan(
      [
        provider({ id: 'bun', label: 'Bun', bytes: 10 }),
        provider({ id: 'nuget', label: 'NuGet', bytes: 900 }),
        provider({ id: 'cargo', label: 'Cargo', bytes: 0 }),
        provider({ id: 'pub', label: 'pub', bytes: 90 }),
      ],
      { keep: 1 },
    );
    expect(summary.parts).toEqual([
      { id: 'nuget', label: 'NuGet', bytes: 900 },
      { id: 'pub', label: 'pub', bytes: 90 },
      { id: 'bun', label: 'Bun', bytes: 10 },
    ]);
  });

  it('counts packages once however many versions they have, and ignores the unversioned', () => {
    const summary = summarizeScan(
      [
        provider({
          id: 'bun',
          bytes: 10,
          items: [
            scanItem('react', '1.0.0', 1),
            scanItem('react', '2.0.0', 1),
            scanItem('other', null, 1),
          ],
        }),
      ],
      { keep: 1 },
    );
    expect(summary.packageCount).toBe(1);
  });

  it('still counts the size of a cache that is not ready, so the total is honest', () => {
    const summary = summarizeScan(
      [provider({ id: 'nuget', status: 'unverified', bytes: 500, items: [] })],
      { keep: 1 },
    );
    expect(summary.totalBytes).toBe(500);
    expect(summary.reclaimableBytes).toBe(0);
  });
});
