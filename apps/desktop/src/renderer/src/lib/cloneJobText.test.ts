import type { CloneJob } from '@shared/apiTypes';
import { describe, expect, it } from 'vitest';
import { cloneHeadline, clonePhaseLabel, cloneTransferText, PHASE_MARKS } from './cloneJobText';

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

describe('clonePhaseLabel', () => {
  it('names each step the way someone waiting on it thinks of it', () => {
    expect(clonePhaseLabel(job())).toBe('Contacting GitHub');
    expect(clonePhaseLabel(job({ phase: 'remote' }))).toBe('Preparing on GitHub');
    expect(clonePhaseLabel(job({ phase: 'receiving' }))).toBe('Downloading');
    expect(clonePhaseLabel(job({ phase: 'resolving' }))).toBe('Unpacking');
    expect(clonePhaseLabel(job({ phase: 'checkout' }))).toBe('Writing files');
  });

  it('says what happened once the job is over', () => {
    expect(clonePhaseLabel(job({ status: 'succeeded' }))).toBe('Cloned');
    expect(clonePhaseLabel(job({ status: 'succeeded', attach: true }))).toBe('Connected');
    expect(clonePhaseLabel(job({ status: 'failed' }))).toBe('Clone failed');
    expect(clonePhaseLabel(job({ status: 'cancelled' }))).toBe('Stopped');
  });

  it('says connecting rather than cloning for a folder that already has files', () => {
    expect(clonePhaseLabel(job({ attach: true, phase: 'checkout' }))).toBe('Finishing');
  });
});

describe('cloneTransferText', () => {
  it('shows how much came down and how fast', () => {
    expect(
      cloneTransferText(job({ receivedBytes: 12 * 1024 * 1024, bytesPerSecond: 2 * 1024 * 1024 })),
    ).toMatch(/^12(\.0)? MB · 2(\.0)? MB\/s$/);
  });

  it('drops the speed once git stops reporting one, and says nothing before any bytes', () => {
    expect(cloneTransferText(job({ receivedBytes: 2048 }))).toMatch(/^2(\.0)? KB$/);
    expect(cloneTransferText(job())).toBeNull();
    expect(cloneTransferText(job({ status: 'failed', receivedBytes: 2048 }))).toBeNull();
  });
});

describe('cloneHeadline', () => {
  it('reads as a result for toasts and notifications', () => {
    expect(cloneHeadline(job({ status: 'succeeded' }))).toBe('My app is ready');
    expect(cloneHeadline(job({ status: 'failed' }))).toBe("Couldn't clone My app");
    expect(cloneHeadline(job({ status: 'cancelled' }))).toBe('Stopped cloning My app');
    expect(cloneHeadline(job())).toBe('Cloning My app');
  });
});

describe('PHASE_MARKS', () => {
  it('sits where main hands one git phase to the next', () => {
    expect(PHASE_MARKS).toEqual([10, 75, 92]);
  });
});
