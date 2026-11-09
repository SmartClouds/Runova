import { describe, expect, it } from 'vitest';
import type { RunRow } from '@/hooks/useRunRows';
import type { PlanJob } from '@/stores/relayPlanJobsStore';
import { statusFeedOf } from './useStatusFeed';

function row(change: Partial<RunRow> = {}): RunRow {
  return {
    session: { id: 's1', title: 'dev' } as RunRow['session'],
    status: { cpuPercent: 12.5, memBytes: 2048 } as RunRow['status'],
    cpuReady: true,
    urls: ['http://localhost:3000/'],
    ports: [3000],
    mobile: false,
    device: null,
    state: 'running',
    pause: null,
    ...change,
  };
}

const job = {
  key: 'split:p1',
  kind: 'split',
  projectId: 'p1',
  projectName: 'Shop',
  requestId: 'r1',
  startedAt: 1000,
  text: 'a long private brief',
  budget: 5,
  status: 'running',
  result: null,
  proposal: null,
  error: null,
} as PlanJob;

describe('statusFeedOf', () => {
  it('passes on what the bar shows for a run', () => {
    expect(statusFeedOf([row()], {}).runs).toEqual([
      {
        id: 's1',
        title: 'dev',
        state: 'running',
        cpuPercent: 12.5,
        memBytes: 2048,
        urls: ['http://localhost:3000/'],
        device: null,
      },
    ]);
  });

  it('holds back the CPU figure until it means something', () => {
    expect(statusFeedOf([row({ cpuReady: false })], {}).runs[0]?.cpuPercent).toBeNull();
  });

  it('copes with a run that has no reading yet', () => {
    const [run] = statusFeedOf([row({ status: null, state: 'starting' })], {}).runs;
    expect(run).toMatchObject({ cpuPercent: null, memBytes: null, state: 'starting' });
  });

  it('names the device by its readable name', () => {
    const [run] = statusFeedOf([row({ device: { name: 'Pixel 8', serial: 'x' } })], {}).runs;
    expect(run?.device).toBe('Pixel 8');
  });

  it('sends a plan without what the person typed or what came back', () => {
    const { plans } = statusFeedOf([], { 'split:p1': job, gone: undefined });
    expect(plans).toEqual([
      {
        key: 'split:p1',
        kind: 'split',
        projectName: 'Shop',
        status: 'running',
        startedAt: 1000,
        error: null,
      },
    ]);
  });
});
