import type { AiAuditProfile } from './constants.js';
import {
  AI_AUDIT_SEVERITIES,
  type AiAuditCondition,
  type AiAuditEvidence,
  type AiAuditFinding,
  type AiAuditFindingCounts,
  type AiAuditLedgerSummary,
  type AiAuditRunMetadata,
  type AiAuditRunStatus,
  type AiAuditScore,
  type AiAuditSeverity,
  type AiAuditTraceStep,
} from './types.js';

/**
 * Readers for the files a security-audit run writes. An agent writes them, so any of them can be
 * cut off mid-write, hand-edited, or not quite match the schema. Each reader keeps what is valid
 * and never throws: a run with one malformed finding still shows the other forty.
 */

type Json = Record<string, unknown>;

const FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const TRACE_KINDS = new Set(['entrypoint', 'propagation', 'sink']);
const RUN_STATUSES = new Set<AiAuditRunStatus>(['in_progress', 'complete', 'incomplete']);
const PROFILES = new Set<AiAuditProfile>(['quick', 'standard', 'deep']);
const CONFIDENCE = new Set(['low', 'medium', 'high']);
/** Ledger statuses that still have work ahead of them; every other status is a final answer. */
const OPEN_LEDGER_STATUSES = new Set(['planned', 'in_progress']);

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function isSeverity(value: unknown): value is AiAuditSeverity {
  return typeof value === 'string' && (AI_AUDIT_SEVERITIES as readonly string[]).includes(value);
}

function line(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

function traceStep(raw: unknown): AiAuditTraceStep | null {
  if (!isObject(raw) || !TRACE_KINDS.has(text(raw.kind)) || !text(raw.file)) return null;
  const at = line(raw.line);
  if (at === null) return null;
  return {
    kind: raw.kind as AiAuditTraceStep['kind'],
    file: text(raw.file),
    line: at,
    scope: text(raw.scope),
    description: text(raw.description),
  };
}

function evidenceItem(raw: unknown): AiAuditEvidence | null {
  if (!isObject(raw) || !text(raw.file)) return null;
  const at = line(raw.line);
  if (at === null) return null;
  return { file: text(raw.file), line: at, description: text(raw.description) };
}

function score(raw: unknown): AiAuditScore {
  return isObject(raw) && isSeverity(raw.score)
    ? { score: raw.score, reason: text(raw.reason) }
    : { score: 'informational', reason: '' };
}

function compact<T>(items: (T | null)[]): T[] {
  return items.filter((item): item is T => item !== null);
}

function finding(raw: unknown): AiAuditFinding | null {
  if (!isObject(raw)) return null;
  const fingerprint = text(raw.fingerprint);
  const title = text(raw.title);
  if (!FINGERPRINT.test(fingerprint) || !title || !Array.isArray(raw.trace)) return null;
  // The schema asks for at least one step; a step with a bad line is dropped on its own, but a
  // finding with no usable step left points nowhere.
  const trace = compact(raw.trace.map(traceStep));
  if (trace.length === 0) return null;
  const base = {
    fingerprint,
    title,
    description: text(raw.description),
    trace,
    evidence: compact((Array.isArray(raw.evidence) ? raw.evidence : []).map(evidenceItem)),
  };

  if (raw.verdict === 'confirmed') {
    const severity = isObject(raw.severity) ? raw.severity : {};
    if (!isSeverity(severity.overall_severity)) return null;
    const execution = isObject(raw.execution) ? raw.execution : {};
    const remediation = isObject(raw.remediation) ? raw.remediation : {};
    const confidence = isObject(raw.confidence) ? raw.confidence : {};
    const codeChanges = Array.isArray(remediation.code_changes)
      ? remediation.code_changes.flatMap((change) =>
          isObject(change) && text(change.file_name)
            ? [{ file_name: text(change.file_name), fixed_code: text(change.fixed_code) }]
            : [],
        )
      : [];
    return {
      ...base,
      verdict: 'confirmed',
      root_cause: text(raw.root_cause),
      intended_behavior: text(raw.intended_behavior),
      conditions: (Array.isArray(raw.conditions) ? raw.conditions : []).flatMap(
        (condition): AiAuditCondition[] =>
          isObject(condition) && text(condition.description)
            ? [{ kind: text(condition.kind), description: text(condition.description) }]
            : [],
      ),
      execution: {
        attacker_perspective: text(execution.attacker_perspective),
        payloads: textList(execution.payloads),
        instructions: textList(execution.instructions),
        observed_result: text(execution.observed_result),
      },
      remediation: {
        strategy: text(remediation.strategy),
        ...(codeChanges.length > 0 ? { code_changes: codeChanges } : {}),
      },
      severity: {
        likelihood: score(severity.likelihood),
        impact: score(severity.impact),
        overall_severity: severity.overall_severity,
      },
      confidence: {
        score: CONFIDENCE.has(text(confidence.score))
          ? (confidence.score as 'low' | 'medium' | 'high')
          : 'low',
        reason: text(confidence.reason),
      },
    };
  }

  if (raw.verdict === 'needs_validation') {
    const plan = isObject(raw.validation_plan) ? raw.validation_plan : {};
    return {
      ...base,
      verdict: 'needs_validation',
      claimed_root_cause: text(raw.claimed_root_cause),
      blockers: textList(raw.blockers),
      validation_plan: {
        ...(text(plan.local) ? { local: text(plan.local) } : {}),
        ...(text(plan.deployment) ? { deployment: text(plan.deployment) } : {}),
      },
    };
  }

  if (raw.verdict === 'rejected') {
    return {
      ...base,
      verdict: 'rejected',
      claimed_root_cause: text(raw.claimed_root_cause),
      reason: text(raw.reason),
    };
  }

  return null;
}

/** findings.json is a bare array of records, one of three shapes picked by `verdict`. */
export function parseAuditFindings(raw: unknown): { findings: AiAuditFinding[]; dropped: number } {
  if (!Array.isArray(raw)) return { findings: [], dropped: 0 };
  const findings = compact(raw.map(finding));
  return { findings, dropped: raw.length - findings.length };
}

export function countAuditFindings(findings: readonly AiAuditFinding[]): AiAuditFindingCounts {
  const counts: AiAuditFindingCounts = {
    confirmed: 0,
    needsValidation: 0,
    rejected: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 },
  };
  for (const entry of findings) {
    if (entry.verdict === 'confirmed') {
      counts.confirmed += 1;
      counts.bySeverity[entry.severity.overall_severity] += 1;
    } else if (entry.verdict === 'needs_validation') {
      counts.needsValidation += 1;
    } else {
      counts.rejected += 1;
    }
  }
  return counts;
}

export function parseRunMetadata(raw: unknown): AiAuditRunMetadata | null {
  if (!isObject(raw)) return null;
  const status = text(raw.run_status) as AiAuditRunStatus;
  const profile = text(raw.profile) as AiAuditProfile;
  return {
    runStatus: RUN_STATUSES.has(status) ? status : null,
    incompleteReason: text(raw.incomplete_reason) || null,
    profile: PROFILES.has(profile) ? profile : null,
    target: text(raw.target) || null,
  };
}

/** coverage-ledger.json is a bare array of units, each with a `status`. */
export function summarizeLedger(raw: unknown): AiAuditLedgerSummary | null {
  if (!Array.isArray(raw)) return null;
  const byStatus: Record<string, number> = {};
  let settled = 0;
  for (const unit of raw) {
    const status = isObject(unit) ? text(unit.status) || 'unknown' : 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (status !== 'unknown' && !OPEN_LEDGER_STATUSES.has(status)) settled += 1;
  }
  return { total: raw.length, settled, byStatus };
}
