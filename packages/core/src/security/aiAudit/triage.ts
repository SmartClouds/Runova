import { isAuditFingerprint } from './parse.js';
import type {
  AiAuditFinding,
  AiAuditTriage,
  AiAuditTriageEntry,
  AiAuditTriageStatus,
  AiAuditVerdict,
} from './types.js';

/**
 * Runova's own record of what happened to each finding after a run ended. It sits in the run
 * folder beside the skill's files, as JSON a person or an agent can edit by hand:
 *
 *   { "findings": { "<fingerprint>": { "status": "fixed", "note": "..." } } }
 *
 * The skill never reads it, and findings.json is never rewritten, so the audit's own verdicts stay
 * as the audit left them.
 */

export const AI_AUDIT_TRIAGE_FILE = 'runova-triage.json';

export const AI_AUDIT_TRIAGE_STATUSES: readonly AiAuditTriageStatus[] = [
  'confirmed',
  'not_a_bug',
  'fixed',
];

/** A note is a sentence or two; anything longer is cut, not refused. */
export const AI_AUDIT_TRIAGE_NOTE_MAX = 2000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is AiAuditTriageStatus {
  return (
    typeof value === 'string' && (AI_AUDIT_TRIAGE_STATUSES as readonly string[]).includes(value)
  );
}

function entry(raw: unknown): AiAuditTriageEntry | null {
  if (!isObject(raw) || !isStatus(raw.status)) return null;
  return {
    status: raw.status,
    // Runova always writes `by`; an entry without one came from an agent editing the file.
    by: raw.by === 'you' ? 'you' : 'agent',
    note: typeof raw.note === 'string' ? raw.note.slice(0, AI_AUDIT_TRIAGE_NOTE_MAX) : '',
    at: typeof raw.at === 'string' ? raw.at : '',
  };
}

/** Reads runova-triage.json. Anything malformed is skipped, never thrown. */
export function parseAuditTriage(raw: unknown): AiAuditTriage {
  const triage: AiAuditTriage = {};
  if (!isObject(raw) || !isObject(raw.findings)) return triage;
  for (const [fingerprint, value] of Object.entries(raw.findings)) {
    const parsed = isAuditFingerprint(fingerprint) ? entry(value) : null;
    if (parsed) triage[fingerprint] = parsed;
  }
  return triage;
}

export function serializeAuditTriage(triage: AiAuditTriage): string {
  return `${JSON.stringify({ findings: triage }, null, 2)}\n`;
}

/**
 * Applies one change from the report. `null` clears the finding back to the audit's verdict.
 * Throws on a fingerprint or status that is not one, since that only comes from a bad caller.
 */
export function applyAuditTriage(
  triage: AiAuditTriage,
  fingerprint: unknown,
  change: { status: unknown; note?: unknown } | null,
  at: string,
): AiAuditTriage {
  if (!isAuditFingerprint(fingerprint)) throw new Error('Not a finding fingerprint.');
  const next = { ...triage };
  if (change === null) {
    delete next[fingerprint];
    return next;
  }
  if (!isStatus(change.status)) throw new Error('Not a triage status.');
  next[fingerprint] = {
    status: change.status,
    by: 'you',
    note: typeof change.note === 'string' ? change.note.slice(0, AI_AUDIT_TRIAGE_NOTE_MAX) : '',
    at,
  };
  return next;
}

/** Where a finding is listed once what was decided since the run is applied. */
export type AiAuditBucket = AiAuditVerdict | 'fixed';

export function auditFindingBucket(finding: AiAuditFinding, triage: AiAuditTriage): AiAuditBucket {
  switch (triage[finding.fingerprint]?.status) {
    case 'fixed':
      return 'fixed';
    case 'not_a_bug':
      return 'rejected';
    case 'confirmed':
      return 'confirmed';
    default:
      return finding.verdict;
  }
}
