import { describe, expect, it } from 'vitest';
import {
  CONFIRMED_CRITICAL,
  CONFIRMED_LOW,
  CONFIRMED_SQLI,
  NEEDS_VALIDATION_SSRF,
  REJECTED_XSS,
} from './__fixtures__/findings.js';
import {
  countAuditFindings,
  parseAuditFindings,
  parseRunMetadata,
  summarizeLedger,
} from './parse.js';

/**
 * findings.json is written by an agent, so it can be cut off, hand-edited or simply wrong. Every
 * parser here keeps what is valid and never throws.
 */

describe('parseAuditFindings', () => {
  it('reads one record of each verdict', () => {
    const { findings, dropped } = parseAuditFindings([
      CONFIRMED_SQLI,
      NEEDS_VALIDATION_SSRF,
      REJECTED_XSS,
    ]);

    expect(dropped).toBe(0);
    expect(findings.map((f) => f.verdict)).toEqual(['confirmed', 'needs_validation', 'rejected']);
    const confirmed = findings[0];
    expect(confirmed.verdict === 'confirmed' && confirmed.severity.overall_severity).toBe('high');
    expect(confirmed.trace[1]).toEqual(CONFIRMED_SQLI.trace[1]);
  });

  it('drops records that do not match the schema and counts them', () => {
    const { findings, dropped } = parseAuditFindings([
      CONFIRMED_SQLI,
      { ...CONFIRMED_SQLI, verdict: 'maybe' },
      { ...CONFIRMED_SQLI, severity: { overall_severity: 'apocalyptic' } },
      { ...NEEDS_VALIDATION_SSRF, trace: 'not a list' },
      { ...REJECTED_XSS, fingerprint: '' },
      null,
      'text',
    ]);

    expect(findings).toHaveLength(1);
    expect(dropped).toBe(6);
  });

  it('drops trace steps with a bad line rather than the whole finding', () => {
    const { findings } = parseAuditFindings([
      {
        ...CONFIRMED_SQLI,
        trace: [...CONFIRMED_SQLI.trace, { kind: 'sink', file: 'x.ts', line: 0 }],
      },
    ]);

    expect(findings[0].trace).toHaveLength(2);
  });

  it('gives nothing, not an error, for input that is not a list', () => {
    expect(parseAuditFindings({ findings: [] })).toEqual({ findings: [], dropped: 0 });
    expect(parseAuditFindings(null)).toEqual({ findings: [], dropped: 0 });
  });
});

describe('countAuditFindings', () => {
  it('counts verdicts, and severities of confirmed findings only', () => {
    const { findings } = parseAuditFindings([
      CONFIRMED_SQLI,
      CONFIRMED_LOW,
      CONFIRMED_CRITICAL,
      NEEDS_VALIDATION_SSRF,
      REJECTED_XSS,
    ]);

    expect(countAuditFindings(findings)).toEqual({
      confirmed: 3,
      needsValidation: 1,
      rejected: 1,
      bySeverity: { critical: 1, high: 1, medium: 0, low: 1, informational: 0 },
    });
  });
});

describe('parseRunMetadata', () => {
  it('reads the run status, its reason and the profile', () => {
    expect(
      parseRunMetadata({
        run_id: 'r1',
        run_status: 'incomplete',
        incomplete_reason: 'critic_budget_exhausted',
        profile: 'deep',
        target: 'shop',
      }),
    ).toEqual({
      runStatus: 'incomplete',
      incompleteReason: 'critic_budget_exhausted',
      profile: 'deep',
      target: 'shop',
    });
  });

  it('keeps what it can from a partial file', () => {
    expect(parseRunMetadata({ run_status: 'weird', profile: 7 })).toEqual({
      runStatus: null,
      incompleteReason: null,
      profile: null,
      target: null,
    });
    expect(parseRunMetadata('nope')).toBeNull();
  });
});

describe('summarizeLedger', () => {
  it('counts units and how many are settled', () => {
    const summary = summarizeLedger([
      { coverage_id: 'a', status: 'covered' },
      { coverage_id: 'b', status: 'candidate' },
      { coverage_id: 'c', status: 'planned' },
      { coverage_id: 'd', status: 'in_progress' },
      { coverage_id: 'e', status: 'out_of_scope' },
    ]);

    expect(summary).toEqual({
      total: 5,
      settled: 3,
      byStatus: { covered: 1, candidate: 1, planned: 1, in_progress: 1, out_of_scope: 1 },
    });
  });

  it('is null for something that is not a ledger', () => {
    expect(summarizeLedger({})).toBeNull();
  });
});
