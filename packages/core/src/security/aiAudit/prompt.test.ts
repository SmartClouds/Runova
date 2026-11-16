import { describe, expect, it } from 'vitest';
import {
  CONFIRMED_CRITICAL,
  CONFIRMED_LOW,
  CONFIRMED_SQLI,
  NEEDS_VALIDATION_SSRF,
  REJECTED_XSS,
} from './__fixtures__/findings.js';
import { parseAuditFindings } from './parse.js';
import {
  AI_AUDIT_FULL_DETAIL_LIMIT,
  buildAiAuditFixPrompt,
  buildAiAuditValidationPrompt,
  buildSecurityAuditPrompt,
} from './prompt.js';

describe('buildSecurityAuditPrompt', () => {
  it('asks for a full audit with the skill, written to the run folder', () => {
    const prompt = buildSecurityAuditPrompt({
      outputDir: '/home/me/security-audit-skill/shop/run-3',
      profile: 'standard',
      scopePaths: [],
    });

    expect(prompt).toMatch(/security-audit skill/);
    expect(prompt).toMatch(/full security audit/i);
    expect(prompt).toContain('/home/me/security-audit-skill/shop/run-3');
    expect(prompt).toMatch(/profile: standard/i);
    expect(prompt).toMatch(/whole repository/i);
    expect(prompt).toMatch(/run_status/);
  });

  it('limits the audit to the folders picked', () => {
    const prompt = buildSecurityAuditPrompt({
      outputDir: '/out/run-1',
      profile: 'quick',
      scopePaths: ['src/api', 'src/auth'],
    });

    expect(prompt).toMatch(/profile: quick/i);
    expect(prompt).toContain('src/api');
    expect(prompt).toContain('src/auth');
    expect(prompt).not.toMatch(/whole repository/i);
  });
});

describe('buildAiAuditFixPrompt', () => {
  const { findings } = parseAuditFindings([
    CONFIRMED_LOW,
    NEEDS_VALIDATION_SSRF,
    CONFIRMED_SQLI,
    REJECTED_XSS,
    CONFIRMED_CRITICAL,
  ]);

  it('lists confirmed findings worst first, with where they are and how to fix them', () => {
    const prompt = buildAiAuditFixPrompt(findings, { projectName: 'Shop' });

    expect(prompt).toContain('Shop');
    const critical = prompt.indexOf('Command injection in admin runner');
    const high = prompt.indexOf('SQL injection in user search');
    const low = prompt.indexOf('Missing security headers');
    expect(critical).toBeGreaterThan(-1);
    expect(critical).toBeLessThan(high);
    expect(high).toBeLessThan(low);
    expect(prompt).toContain('src/db/users.ts:42');
    expect(prompt).toContain('Use a parameterized query.');
  });

  it('leaves out rejected and unverified findings', () => {
    const prompt = buildAiAuditFixPrompt(findings, { projectName: 'Shop' });

    expect(prompt).not.toContain('XSS in the profile view');
    expect(prompt).not.toContain('Possible SSRF in the image proxy');
  });

  it('is empty when nothing was confirmed', () => {
    const rejectedOnly = parseAuditFindings([REJECTED_XSS]).findings;
    expect(buildAiAuditFixPrompt(rejectedOnly, { projectName: 'Shop' })).toBe('');
  });

  it('takes in findings confirmed since the run and drops ones fixed or ruled out', () => {
    const prompt = buildAiAuditFixPrompt(findings, {
      projectName: 'Shop',
      triage: {
        'ssrf:src/fetch.ts:20': {
          status: 'confirmed',
          by: 'you',
          note: 'Test reaches 169.254.',
          at: '',
        },
        'rce:src/admin/run.ts:9': { status: 'fixed', by: 'agent', note: '', at: '' },
        'headers:src/server.ts:3': { status: 'not_a_bug', by: 'you', note: '', at: '' },
      },
    });

    expect(prompt).toContain('[Confirmed after the audit] Possible SSRF in the image proxy');
    expect(prompt).toContain('Test reaches 169.254.');
    expect(prompt).not.toContain('Command injection in admin runner');
    expect(prompt).not.toContain('Missing security headers');
    // The audit's own confirmations still lead.
    expect(prompt.indexOf('SQL injection')).toBeLessThan(prompt.indexOf('Possible SSRF'));
  });

  it('tells the agent where to record what it fixed', () => {
    const prompt = buildAiAuditFixPrompt(findings, {
      projectName: 'Shop',
      outputDir: 'C:\\Users\\me\\security-audit-skill\\shop\\run-1',
    });

    expect(prompt).toContain(
      'C:\\Users\\me\\security-audit-skill\\shop\\run-1\\runova-triage.json',
    );
    expect(prompt).toMatch(/"fixed"/);
  });
});

describe('buildAiAuditValidationPrompt', () => {
  const { findings } = parseAuditFindings([CONFIRMED_SQLI, NEEDS_VALIDATION_SSRF, REJECTED_XSS]);

  it('asks to prove each unverified finding with a test, fix the real ones and record it', () => {
    const prompt = buildAiAuditValidationPrompt(findings, {
      projectName: 'Shop',
      outputDir: '/home/me/security-audit-skill/shop/run-1',
    });

    expect(prompt).toContain('Possible SSRF in the image proxy');
    expect(prompt).toContain('Fingerprint: ssrf:src/fetch.ts:20');
    expect(prompt).toContain('Claimed root cause: No allow list for hosts.');
    expect(prompt).toContain(
      'Still unknown: Whether the deployment blocks metadata IPs is unknown.',
    );
    expect(prompt).toMatch(/failing test/);
    expect(prompt).toMatch(/do not contact deployed services/);
    expect(prompt).toContain('/home/me/security-audit-skill/shop/run-1/runova-triage.json');
    expect(prompt).not.toContain('SQL injection in user search');
    expect(prompt).not.toContain('XSS in the profile view');
  });

  it('points at findings.json instead of writing out a long list in full', () => {
    const many = parseAuditFindings(
      Array.from({ length: AI_AUDIT_FULL_DETAIL_LIMIT + 1 }, (_, index) => ({
        ...NEEDS_VALIDATION_SSRF,
        fingerprint: `ssrf:${index}`,
        title: `Lead ${index}`,
      })),
    ).findings;

    const prompt = buildAiAuditValidationPrompt(many, {
      projectName: 'Shop',
      outputDir: '/runs/run-1',
    });

    expect(prompt).toContain(`the ${AI_AUDIT_FULL_DETAIL_LIMIT + 1} findings below`);
    expect(prompt).toContain('/runs/run-1/findings.json');
    expect(prompt).toContain('Lead 3');
    expect(prompt).not.toContain('Still unknown:');
  });

  it('leaves out findings already settled, and is empty once all are', () => {
    const triage = {
      'ssrf:src/fetch.ts:20': { status: 'fixed' as const, by: 'agent' as const, note: '', at: '' },
    };
    expect(buildAiAuditValidationPrompt(findings, { projectName: 'Shop', triage })).toBe('');
  });
});
