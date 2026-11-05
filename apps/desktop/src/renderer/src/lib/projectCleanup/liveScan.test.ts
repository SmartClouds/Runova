import type { CleanupCandidate, CleanupScanEvent } from '@shared/projectCleanupTypes';
import { describe, expect, it } from 'vitest';
import { applyScanEvent, EMPTY_LIVE_SCAN, liveToScan } from './liveScan';

function candidate(over: Partial<CleanupCandidate> = {}): CleanupCandidate {
  return {
    id: 'main:node_modules',
    locationId: 'main',
    relPath: 'node_modules',
    name: 'node_modules',
    category: 'dependencies',
    bytes: 100,
    sharedBytes: 0,
    files: 1,
    modifiedAt: 0,
    restore: { label: 'x', command: 'npm install' },
    locked: null,
    ...over,
  };
}

const R = 'req';

describe('applyScanEvent', () => {
  it('starts empty', () => {
    expect(EMPTY_LIVE_SCAN).toMatchObject({
      locations: [],
      studio: [],
      files: 0,
      lookingIn: null,
    });
  });

  it('adds a place as it starts being looked at, and says so', () => {
    const next = applyScanEvent(EMPTY_LIVE_SCAN, {
      requestId: R,
      type: 'location',
      locationId: 'main',
      label: 'Project folder',
      isMain: true,
    });
    expect(next.lookingIn).toBe('Project folder');
    expect(next.locations).toHaveLength(1);
    expect(next.locations[0]).toMatchObject({
      id: 'main',
      label: 'Project folder',
      isMain: true,
      candidates: [],
    });
  });

  it('files a folder under the place it was found in', () => {
    let live = EMPTY_LIVE_SCAN;
    const events: CleanupScanEvent[] = [
      { requestId: R, type: 'location', locationId: 'main', label: 'Project folder', isMain: true },
      { requestId: R, type: 'location', locationId: 'wt1', label: 'feature/x', isMain: false },
      { requestId: R, type: 'candidate', candidate: candidate() },
      {
        requestId: R,
        type: 'candidate',
        candidate: candidate({ id: 'wt1:dist', locationId: 'wt1', relPath: 'dist' }),
      },
    ];
    for (const event of events) live = applyScanEvent(live, event);
    expect(live.locations.map((l) => l.candidates.map((c) => c.id))).toEqual([
      ['main:node_modules'],
      ['wt1:dist'],
    ]);
  });

  it('keeps a folder whose place it has not heard of, in a place made for it', () => {
    const live = applyScanEvent(EMPTY_LIVE_SCAN, {
      requestId: R,
      type: 'candidate',
      candidate: candidate({ locationId: 'late', id: 'late:dist', relPath: 'dist' }),
    });
    expect(live.locations).toHaveLength(1);
    expect(live.locations[0]?.candidates).toHaveLength(1);
  });

  it('counts the files it is told about', () => {
    let live = applyScanEvent(EMPTY_LIVE_SCAN, {
      requestId: R,
      type: 'progress',
      locationId: 'main',
      files: 250,
    });
    expect(live.files).toBe(250);
    live = applyScanEvent(live, { requestId: R, type: 'progress', locationId: 'main', files: 900 });
    expect(live.files).toBe(900);
  });

  it('adds the files of each place together, since each place counts from zero', () => {
    let live = EMPTY_LIVE_SCAN;
    live = applyScanEvent(live, {
      requestId: R,
      type: 'location',
      locationId: 'main',
      label: 'a',
      isMain: true,
    });
    live = applyScanEvent(live, { requestId: R, type: 'progress', locationId: 'main', files: 500 });
    live = applyScanEvent(live, {
      requestId: R,
      type: 'location',
      locationId: 'wt1',
      label: 'b',
      isMain: false,
    });
    live = applyScanEvent(live, { requestId: R, type: 'progress', locationId: 'wt1', files: 120 });
    expect(live.files).toBe(620);
  });

  it('takes the Studio videos as they come', () => {
    const videos = [{ videoId: 'v1', title: 'Launch', bytes: 5, busy: false }];
    const live = applyScanEvent(EMPTY_LIVE_SCAN, { requestId: R, type: 'studio', videos });
    expect(live.studio).toEqual(videos);
  });

  it('does not change the state it was given', () => {
    const before = applyScanEvent(EMPTY_LIVE_SCAN, {
      requestId: R,
      type: 'location',
      locationId: 'main',
      label: 'Project folder',
      isMain: true,
    });
    const snapshot = JSON.stringify(before);
    applyScanEvent(before, { requestId: R, type: 'candidate', candidate: candidate() });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('liveToScan', () => {
  it('turns what has arrived into a scan the list can show', () => {
    let live = applyScanEvent(EMPTY_LIVE_SCAN, {
      requestId: R,
      type: 'location',
      locationId: 'main',
      label: 'Project folder',
      isMain: true,
    });
    live = applyScanEvent(live, { requestId: R, type: 'candidate', candidate: candidate() });
    const scan = liveToScan('p1', live, 42);
    expect(scan).toMatchObject({ projectId: 'p1', scannedAt: 42, studio: [] });
    expect(scan.locations[0]?.candidates).toHaveLength(1);
  });
});
