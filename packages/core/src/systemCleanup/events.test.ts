import { describe, expect, it } from 'vitest';
import {
  applyCleanEvent,
  applyScanEvent,
  type CleanProgress,
  cleanFraction,
  IDLE_CLEAN,
  IDLE_SCAN,
  type ScanProgress,
} from './events.js';
import type { ProviderScan, SystemCleanEvent, SystemScanEvent } from './types.js';

function providerScan(overrides: Partial<ProviderScan> = {}): ProviderScan {
  return {
    id: 'nuget',
    label: 'NuGet',
    tagline: '',
    kind: 'versioned',
    status: 'ready',
    root: '/c',
    bytes: 500,
    files: 9,
    sharedBytes: 0,
    unreadable: 0,
    items: [],
    clearCommand: null,
    tidyCommand: null,
    afterClearing: '',
    ...overrides,
  };
}

function scanRun(events: SystemScanEvent[], from: ScanProgress = IDLE_SCAN): ScanProgress {
  return events.reduce(applyScanEvent, from);
}

const started: SystemScanEvent = {
  type: 'started',
  requestId: 'r1',
  scanId: 's1',
  providers: [
    { id: 'nuget', label: 'NuGet' },
    { id: 'bun', label: 'Bun' },
  ],
};

describe('applyScanEvent', () => {
  it('starts with every cache waiting its turn', () => {
    const state = scanRun([started]);
    expect(state.running).toBe(true);
    expect(state.requestId).toBe('r1');
    expect(state.order).toEqual(['nuget', 'bun']);
    expect(state.providers.nuget).toMatchObject({
      status: 'queued',
      bytes: 0,
      files: 0,
      result: null,
    });
  });

  it('marks the cache being looked at and counts up what it finds', () => {
    const state = scanRun([
      started,
      { type: 'provider-started', requestId: 'r1', providerId: 'nuget' },
      { type: 'progress', requestId: 'r1', providerId: 'nuget', bytes: 100, files: 4 },
      { type: 'progress', requestId: 'r1', providerId: 'nuget', bytes: 250, files: 9 },
    ]);
    expect(state.providers.nuget).toMatchObject({ status: 'scanning', bytes: 250, files: 9 });
    expect(state.providers.bun?.status).toBe('queued');
  });

  it('never lets a count go backwards when events arrive out of order', () => {
    const state = scanRun([
      started,
      { type: 'provider-started', requestId: 'r1', providerId: 'nuget' },
      { type: 'progress', requestId: 'r1', providerId: 'nuget', bytes: 250, files: 9 },
      { type: 'progress', requestId: 'r1', providerId: 'nuget', bytes: 100, files: 4 },
    ]);
    expect(state.providers.nuget).toMatchObject({ bytes: 250, files: 9 });
  });

  it('takes the final answer for a cache from its result', () => {
    const result = providerScan({ bytes: 777, files: 12 });
    const state = scanRun([
      started,
      { type: 'provider-started', requestId: 'r1', providerId: 'nuget' },
      { type: 'progress', requestId: 'r1', providerId: 'nuget', bytes: 100, files: 4 },
      { type: 'provider-done', requestId: 'r1', provider: result },
    ]);
    expect(state.providers.nuget).toMatchObject({ status: 'ready', bytes: 777, files: 12, result });
  });

  it('is finished when the run says so, and remembers whether it was cut short', () => {
    const state = scanRun([started, { type: 'finished', requestId: 'r1', cancelled: true }]);
    expect(state.running).toBe(false);
    expect(state.cancelled).toBe(true);
  });

  it('ignores events from a run that is not this one', () => {
    const before = scanRun([started]);
    const after = scanRun(
      [
        { type: 'progress', requestId: 'old', providerId: 'nuget', bytes: 999, files: 9 },
        { type: 'finished', requestId: 'old', cancelled: false },
      ],
      before,
    );
    expect(after).toEqual(before);
  });

  it('starts over when a new run starts', () => {
    const first = scanRun([
      started,
      { type: 'provider-done', requestId: 'r1', provider: providerScan() },
      { type: 'finished', requestId: 'r1', cancelled: false },
    ]);
    const second = scanRun([{ ...started, requestId: 'r2', scanId: 's2' }], first);
    expect(second.requestId).toBe('r2');
    expect(second.running).toBe(true);
    expect(second.providers.nuget?.result).toBeNull();
  });

  it('ignores a cache it was not told about', () => {
    const state = scanRun([
      started,
      { type: 'progress', requestId: 'r1', providerId: 'cargo', bytes: 1, files: 1 },
    ]);
    expect(state.providers.cargo).toBeUndefined();
  });
});

function cleanRun(events: SystemCleanEvent[], from: CleanProgress = IDLE_CLEAN): CleanProgress {
  return events.reduce(applyCleanEvent, from);
}

const cleanStarted: SystemCleanEvent = {
  type: 'started',
  requestId: 'c1',
  providerId: 'nuget',
  total: 4,
  bytes: 4000,
};

describe('applyCleanEvent', () => {
  it('starts a run with nothing done', () => {
    const state = cleanRun([cleanStarted]);
    expect(state).toMatchObject({
      running: true,
      providerId: 'nuget',
      total: 4,
      bytes: 4000,
      processed: 0,
      freedBytes: 0,
    });
  });

  it('counts what was removed and how many bytes that freed', () => {
    const state = cleanRun([
      cleanStarted,
      {
        type: 'item-done',
        requestId: 'c1',
        providerId: 'nuget',
        itemId: 'a',
        label: 'acornima 1.0.0',
        bytes: 1000,
      },
      {
        type: 'item-done',
        requestId: 'c1',
        providerId: 'nuget',
        itemId: 'b',
        label: 'acornima 1.1.0',
        bytes: 500,
      },
    ]);
    expect(state).toMatchObject({ processed: 2, freedBytes: 1500, current: 'acornima 1.1.0' });
    expect(state.failures).toEqual([]);
  });

  it('keeps each failure with its reason and still moves on', () => {
    const state = cleanRun([
      cleanStarted,
      {
        type: 'item-failed',
        requestId: 'c1',
        providerId: 'nuget',
        itemId: 'a',
        label: 'acornima 1.0.0',
        reason: 'In use',
      },
      {
        type: 'item-done',
        requestId: 'c1',
        providerId: 'nuget',
        itemId: 'b',
        label: 'b',
        bytes: 10,
      },
    ]);
    expect(state.processed).toBe(2);
    expect(state.freedBytes).toBe(10);
    expect(state.failures).toEqual([{ itemId: 'a', label: 'acornima 1.0.0', reason: 'In use' }]);
  });

  it('keeps the last lines a command printed, and not more than it should', () => {
    const lines: SystemCleanEvent[] = Array.from({ length: 250 }, (_, index) => ({
      type: 'line',
      requestId: 'c1',
      providerId: 'nuget',
      text: `line ${index}`,
    }));
    const state = cleanRun([cleanStarted, ...lines]);
    expect(state.lines).toHaveLength(200);
    expect(state.lines.at(-1)).toBe('line 249');
    expect(state.lines[0]).toBe('line 50');
  });

  it('finishes, remembering whether it was cut short', () => {
    const state = cleanRun([
      cleanStarted,
      { type: 'finished', requestId: 'c1', providerId: 'nuget', cancelled: true },
    ]);
    expect(state.running).toBe(false);
    expect(state.cancelled).toBe(true);
  });

  it('ignores events from another run', () => {
    const before = cleanRun([cleanStarted]);
    const after = cleanRun(
      [
        {
          type: 'item-done',
          requestId: 'zzz',
          providerId: 'nuget',
          itemId: 'a',
          label: 'a',
          bytes: 5,
        },
      ],
      before,
    );
    expect(after).toEqual(before);
  });
});

describe('cleanFraction', () => {
  it('is how far through the items a run is, never above one', () => {
    expect(cleanFraction({ ...IDLE_CLEAN, total: 4, processed: 1 })).toBe(0.25);
    expect(cleanFraction({ ...IDLE_CLEAN, total: 4, processed: 9 })).toBe(1);
  });

  it('is zero when there is nothing to do or nothing started', () => {
    expect(cleanFraction(IDLE_CLEAN)).toBe(0);
    expect(cleanFraction({ ...IDLE_CLEAN, total: 0, processed: 0 })).toBe(0);
  });
});
