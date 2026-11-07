import type { AiAuditProfile } from './constants.js';

/**
 * The shapes the security-audit skill writes, as its report-schema.json defines them, plus the
 * summaries Runova builds from them. Field names inside findings stay in the skill's snake_case so
 * a record reads the same here as in findings.json.
 */

export type AiAuditSeverity = 'critical' | 'high' | 'medium' | 'low' | 'informational';

export const AI_AUDIT_SEVERITIES: readonly AiAuditSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'informational',
];

export const AI_AUDIT_SEVERITY_LABEL: Record<AiAuditSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  informational: 'Informational',
};

export type AiAuditTraceKind = 'entrypoint' | 'propagation' | 'sink';

export interface AiAuditTraceStep {
  kind: AiAuditTraceKind;
  /** Repository-relative. */
  file: string;
  line: number;
  scope: string;
  description: string;
}

export interface AiAuditEvidence {
  file: string;
  line: number;
  description: string;
}

export interface AiAuditCondition {
  kind: string;
  description: string;
}

export interface AiAuditScore {
  score: AiAuditSeverity;
  reason: string;
}

interface AiAuditFindingBase {
  fingerprint: string;
  title: string;
  description: string;
  trace: AiAuditTraceStep[];
  evidence: AiAuditEvidence[];
}

export interface AiAuditConfirmedFinding extends AiAuditFindingBase {
  verdict: 'confirmed';
  root_cause: string;
  intended_behavior: string;
  conditions: AiAuditCondition[];
  execution: {
    attacker_perspective: string;
    payloads: string[];
    instructions: string[];
    observed_result: string;
  };
  remediation: {
    strategy: string;
    code_changes?: { file_name: string; fixed_code: string }[];
  };
  severity: {
    likelihood: AiAuditScore;
    impact: AiAuditScore;
    overall_severity: AiAuditSeverity;
  };
  confidence: { score: 'low' | 'medium' | 'high'; reason: string };
}

export interface AiAuditNeedsValidationFinding extends AiAuditFindingBase {
  verdict: 'needs_validation';
  claimed_root_cause: string;
  blockers: string[];
  validation_plan: { local?: string; deployment?: string };
}

export interface AiAuditRejectedFinding extends AiAuditFindingBase {
  verdict: 'rejected';
  claimed_root_cause: string;
  reason: string;
}

export type AiAuditFinding =
  | AiAuditConfirmedFinding
  | AiAuditNeedsValidationFinding
  | AiAuditRejectedFinding;

export type AiAuditVerdict = AiAuditFinding['verdict'];

export type AiAuditRunStatus = 'in_progress' | 'complete' | 'incomplete';

export interface AiAuditRunMetadata {
  runStatus: AiAuditRunStatus | null;
  incompleteReason: string | null;
  profile: AiAuditProfile | null;
  target: string | null;
}

export interface AiAuditLedgerSummary {
  total: number;
  /** Units with a final disposition (covered, a candidate, out of scope, blocked, ...). */
  settled: number;
  byStatus: Record<string, number>;
}

export interface AiAuditFindingCounts {
  confirmed: number;
  needsValidation: number;
  rejected: number;
  bySeverity: Record<AiAuditSeverity, number>;
}

export type AiAuditPhase =
  | 'starting'
  | 'reconnaissance'
  | 'hunting'
  | 'validation'
  | 'verification'
  | 'reporting'
  | 'complete'
  | 'incomplete';

/** What the run list shows for each run-<N> folder. */
export interface AiAuditRunSummary {
  runName: string;
  /** Absolute path of the run folder, for display only. Never sent back to main. */
  outputDir: string;
  phase: AiAuditPhase;
  metadata: AiAuditRunMetadata | null;
  counts: AiAuditFindingCounts | null;
  ledger: AiAuditLedgerSummary | null;
  /** When the folder was created. */
  startedAt: string;
  /** The newest change to any file in the run, which tells a working run from a stalled one. */
  lastActivityAt: string;
  hasReport: boolean;
}

/** One run, read in full. */
export interface AiAuditRunDetail extends AiAuditRunSummary {
  findings: AiAuditFinding[];
  /** Records in findings.json that did not match the schema and were left out. */
  droppedFindings: number;
  /** REPORT.md, when the run wrote one (size capped). */
  report: string | null;
}

/** Whether a project is ready to run the audit, and where its runs go. */
export interface AiAuditStatus {
  /** The skill is in one of the project's own agent folders. A global copy alone does not count. */
  installed: boolean;
  /** Every copy found: project paths are relative to the project, global ones start with ~/. */
  locations: { path: string; scope: 'project' | 'global' }[];
  node: { found: boolean; version: string | null; meetsMinimum: boolean };
  /** ~/security-audit-skill/<project folder>, where every run of this project lands. */
  runsRoot: string;
}
