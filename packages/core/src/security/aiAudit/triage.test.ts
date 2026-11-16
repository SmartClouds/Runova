import { describe, expect, it } from 'vitest';
import { CONFIRMED_SQLI, NEEDS_VALIDATION_SSRF, REJECTED_XSS } from './__fixtures__/findings.js';
import { parseAuditFindings } from './parse.js';
import {
  AI_AUDIT_TRIAGE_NOTE_MAX,
  applyAuditTriage,
  auditFindingBucket,
  parseAuditTriage,
  serializeAuditTriage,
} from './triage.js';

/**
 * runova-triage.json is edited by Runova and by agents following its prompts, so the reader keeps
 * what is valid and the writer refuses only what a caller could not have meant.
 */

describe('parseAuditTriage', () => {
  it('reads entries written by Runova and by an agent', () => {
    expect(
      parseAuditTriage({
        findings: {
          'ssrf:src/fetch.ts:20': { status: 'fixed', note: 'Added an allow list.' },
          'sqli:src/db/users.ts:42': {
            status: 'not_a_bug',
            by: 'you',
            note: '',
            at: '2026-11-16T00:00:00Z',
          },
        },
      }),
    ).toEqual({
      'ssrf:src/fetch.ts:20': {
        status: 'fixed',
        by: 'agent',
        note: 'Added an allow list.',
        at: '',
      },
      'sqli:src/db/users.ts:42': {
        status: 'not_a_bug',
        by: 'you',
        note: '',
        at: '2026-11-16T00:00:00Z',
      },
    });
  });

  it('skips what it cannot read', () => {
    expect(
      parseAuditTriage({
        findings: {
          'a:1': { status: 'maybe' },
          '../escape': { status: 'fixed' },
          'b:2': 'fixed',
          'c:3': { status: 'confirmed', note: 7 },
        },
      }),
    ).toEqual({ 'c:3': { status: 'confirmed', by: 'agent', note: '', at: '' } });
    expect(parseAuditTriage(null)).toEqual({});
    expect(parseAuditTriage([])).toEqual({});
    expect(parseAuditTriage({ findings: [] })).toEqual({});
  });

  it('round-trips through the file format', () => {
    const triage = applyAuditTriage({}, 'a:1', { status: 'fixed', note: 'Done.' }, 'now');
    expect(parseAuditTriage(JSON.parse(serializeAuditTriage(triage)))).toEqual(triage);
  });
});

describe('applyAuditTriage', () => {
  it('records a decision as the user, and clears it again', () => {
    const set = applyAuditTriage({}, 'a:1', { status: 'confirmed', note: 'Test fails.' }, 'now');
    expect(set).toEqual({
      'a:1': { status: 'confirmed', by: 'you', note: 'Test fails.', at: 'now' },
    });

    expect(applyAuditTriage(set, 'a:1', null, 'later')).toEqual({});
  });

  it('cuts a long note instead of refusing it', () => {
    const triage = applyAuditTriage({}, 'a:1', { status: 'fixed', note: 'x'.repeat(5000) }, 'now');
    expect(triage['a:1'].note).toHaveLength(AI_AUDIT_TRIAGE_NOTE_MAX);
  });

  it('refuses a bad fingerprint or status', () => {
    expect(() => applyAuditTriage({}, '../x', { status: 'fixed' }, 'now')).toThrow(/fingerprint/);
    expect(() => applyAuditTriage({}, 'a:1', { status: 'gone' }, 'now')).toThrow(/status/);
  });
});

describe('auditFindingBucket', () => {
  const [sqli, ssrf, xss] = parseAuditFindings([
    CONFIRMED_SQLI,
    NEEDS_VALIDATION_SSRF,
    REJECTED_XSS,
  ]).findings;

  it("follows the audit's verdict until something is decided", () => {
    expect(auditFindingBucket(sqli, {})).toBe('confirmed');
    expect(auditFindingBucket(ssrf, {})).toBe('needs_validation');
    expect(auditFindingBucket(xss, {})).toBe('rejected');
  });

  it('moves a finding by what was decided since', () => {
    const at = (status: 'confirmed' | 'not_a_bug' | 'fixed') => ({
      [ssrf.fingerprint]: { status, by: 'you' as const, note: '', at: '' },
    });
    expect(auditFindingBucket(ssrf, at('confirmed'))).toBe('confirmed');
    expect(auditFindingBucket(ssrf, at('not_a_bug'))).toBe('rejected');
    expect(auditFindingBucket(ssrf, at('fixed'))).toBe('fixed');
  });
});
