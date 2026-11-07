import { describe, expect, it } from 'vitest';
import { AI_AUDIT_PHASE_STEPS, inferAuditPhase } from './phase.js';
import type { AiAuditLedgerSummary, AiAuditRunMetadata } from './types.js';

/**
 * The skill does not write which phase it is in, so the tracker reads it off the files: each phase
 * leaves a file behind that the previous one did not.
 */

const running: AiAuditRunMetadata = {
  runStatus: 'in_progress',
  incompleteReason: null,
  profile: 'standard',
  target: null,
};

function ledger(total: number, settled: number): AiAuditLedgerSummary {
  return { total, settled, byStatus: {} };
}

describe('inferAuditPhase', () => {
  it('is starting before the agent has written anything', () => {
    expect(inferAuditPhase({ files: [], metadata: null, ledger: null })).toBe('starting');
  });

  it('is in reconnaissance once the run is recorded', () => {
    expect(inferAuditPhase({ files: ['run-metadata.json'], metadata: running, ledger: null })).toBe(
      'reconnaissance',
    );
    expect(
      inferAuditPhase({
        files: ['run-metadata.json', 'architecture.md'],
        metadata: running,
        ledger: null,
      }),
    ).toBe('reconnaissance');
  });

  it('is hunting while ledger units are still open', () => {
    expect(
      inferAuditPhase({
        files: ['run-metadata.json', 'architecture.md', 'coverage-ledger.json'],
        metadata: running,
        ledger: ledger(10, 4),
      }),
    ).toBe('hunting');
  });

  it('is validating once every unit is settled but no findings are written', () => {
    expect(
      inferAuditPhase({
        files: ['run-metadata.json', 'coverage-ledger.json'],
        metadata: running,
        ledger: ledger(10, 10),
      }),
    ).toBe('validation');
  });

  it('is verifying once findings.json is written, and reporting once REPORT.md is', () => {
    const files = ['run-metadata.json', 'coverage-ledger.json', 'findings.json'];
    expect(inferAuditPhase({ files, metadata: running, ledger: ledger(3, 3) })).toBe(
      'verification',
    );
    expect(
      inferAuditPhase({ files: [...files, 'REPORT.md'], metadata: running, ledger: ledger(3, 3) }),
    ).toBe('reporting');
  });

  it('takes the run status over the files once the run has ended', () => {
    expect(
      inferAuditPhase({
        files: ['run-metadata.json'],
        metadata: { ...running, runStatus: 'complete' },
        ledger: null,
      }),
    ).toBe('complete');
    expect(
      inferAuditPhase({
        files: ['run-metadata.json', 'coverage-ledger.json'],
        metadata: { ...running, runStatus: 'incomplete', incompleteReason: 'budget' },
        ledger: ledger(5, 2),
      }),
    ).toBe('incomplete');
  });
});

describe('AI_AUDIT_PHASE_STEPS', () => {
  it('lists the six phases in order', () => {
    expect(AI_AUDIT_PHASE_STEPS.map((step) => step.label)).toEqual([
      'Reconnaissance',
      'Hunting',
      'Validation',
      'Structured output',
      'Verification',
      'Reporting',
    ]);
  });
});
