import type { AiAuditLedgerSummary, AiAuditPhase, AiAuditRunMetadata } from './types.js';

export type AiAuditStepId =
  | 'reconnaissance'
  | 'hunting'
  | 'validation'
  | 'output'
  | 'verification'
  | 'reporting';

/** The skill's six phases, as the tracker's stepper shows them. */
export const AI_AUDIT_PHASE_STEPS: { id: AiAuditStepId; label: string; description: string }[] = [
  {
    id: 'reconnaissance',
    label: 'Reconnaissance',
    description: 'Maps the architecture, entry points and trust boundaries.',
  },
  {
    id: 'hunting',
    label: 'Hunting',
    description: 'Works through the coverage plan, unit by unit.',
  },
  {
    id: 'validation',
    label: 'Validation',
    description: 'Tries to prove or disprove every candidate.',
  },
  { id: 'output', label: 'Structured output', description: 'Writes findings.json.' },
  {
    id: 'verification',
    label: 'Verification',
    description: 'A fresh agent re-checks each record against the code.',
  },
  { id: 'reporting', label: 'Reporting', description: 'Writes REPORT.md and the details.' },
];

/**
 * How many of the six steps are behind the run. Verification starts once findings.json exists,
 * so by then structured output is already done.
 */
export function completedAuditSteps(phase: AiAuditPhase): number {
  switch (phase) {
    case 'starting':
    case 'reconnaissance':
      return 0;
    case 'hunting':
      return 1;
    case 'validation':
      return 2;
    case 'verification':
      return 4;
    case 'reporting':
      return 5;
    case 'complete':
      return 6;
    case 'incomplete':
      return 0;
  }
}

/**
 * The skill does not record its current phase, so it is read off the files each phase leaves
 * behind. Once the run says it has ended, that wins over the files.
 */
export function inferAuditPhase(input: {
  files: readonly string[];
  metadata: AiAuditRunMetadata | null;
  ledger: AiAuditLedgerSummary | null;
}): AiAuditPhase {
  const { files, metadata, ledger } = input;
  if (metadata?.runStatus === 'complete') return 'complete';
  if (metadata?.runStatus === 'incomplete') return 'incomplete';

  const has = (name: string) => files.includes(name);
  if (has('REPORT.md')) return 'reporting';
  if (has('findings.json')) return 'verification';
  if (ledger && ledger.total > 0) return ledger.settled >= ledger.total ? 'validation' : 'hunting';
  if (metadata || has('run-metadata.json') || has('architecture.md')) return 'reconnaissance';
  return 'starting';
}
