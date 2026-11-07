import type { AiAuditRunSummary } from '@runova/core';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../../test/renderer/renderWithProviders';
import { AuditRunTracker } from './AuditRunTracker';

/**
 * A running audit takes the better part of an hour, so the tracker has to show it is moving: which
 * phase it is in, how much of the plan is covered, and when it last wrote anything.
 */

function run(over: Partial<AiAuditRunSummary> = {}): AiAuditRunSummary {
  return {
    runName: 'run-2',
    outputDir: '/home/me/security-audit-skill/shop/run-2',
    phase: 'hunting',
    metadata: {
      runStatus: 'in_progress',
      incompleteReason: null,
      profile: 'standard',
      target: null,
    },
    counts: null,
    ledger: { total: 10, settled: 4, byStatus: { covered: 4, planned: 6 } },
    startedAt: '2026-11-08T10:00:00Z',
    lastActivityAt: '2026-11-08T10:20:00Z',
    hasReport: false,
    ...over,
  };
}

afterEach(() => vi.useRealTimers());

function renderAt(now: string, summary: AiAuditRunSummary) {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(now) });
  const onOpenAgent = vi.fn();
  const onStopTracking = vi.fn();
  const view = renderWithProviders(
    <AuditRunTracker run={summary} onOpenAgent={onOpenAgent} onStopTracking={onStopTracking} />,
  );
  return { ...view, onOpenAgent, onStopTracking };
}

describe('AuditRunTracker', () => {
  it('marks the phases behind the run, the one it is in, and the ones ahead', () => {
    renderAt('2026-11-08T10:21:00Z', run());

    expect(screen.getByRole('listitem', { name: /Reconnaissance, done/ })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: /Hunting, in progress/ })).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(screen.getByRole('listitem', { name: /Reporting, not started/ })).toBeInTheDocument();
  });

  it('shows how much of the coverage plan is settled', () => {
    renderAt('2026-11-08T10:21:00Z', run());

    expect(screen.getByText('4 of 10 coverage units done')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Coverage' })).toHaveAttribute(
      'aria-valuenow',
      '40',
    );
  });

  it('says when the agent last wrote something, and how long the run has gone', () => {
    renderAt('2026-11-08T10:22:00Z', run());

    expect(screen.getByText(/Last update 2 min ago/)).toBeInTheDocument();
    expect(screen.getByText(/Running for 22 min/)).toBeInTheDocument();
  });

  it('waits for the agent before it has written anything', () => {
    renderAt('2026-11-08T10:00:30Z', run({ phase: 'starting', ledger: null, metadata: null }));

    expect(screen.getByText(/Waiting for the agent to start/)).toBeInTheDocument();
  });

  it('warns that a run gone quiet for half an hour may have stalled', () => {
    renderAt('2026-11-08T10:51:00Z', run());

    expect(screen.getByText(/may have stopped/i)).toBeInTheDocument();
  });

  it('opens the agent tab and stops tracking on request', async () => {
    const { user, onOpenAgent, onStopTracking } = renderAt('2026-11-08T10:21:00Z', run());

    await user.click(screen.getByRole('button', { name: 'Open agent tab' }));
    await user.click(screen.getByRole('button', { name: 'Stop tracking' }));

    expect(onOpenAgent).toHaveBeenCalledTimes(1);
    expect(onStopTracking).toHaveBeenCalledTimes(1);
  });
});
