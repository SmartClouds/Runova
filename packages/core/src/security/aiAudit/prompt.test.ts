import { describe, expect, it } from 'vitest';
import {
  CONFIRMED_CRITICAL,
  CONFIRMED_LOW,
  CONFIRMED_SQLI,
  NEEDS_VALIDATION_SSRF,
  REJECTED_XSS,
} from './__fixtures__/findings.js';
import { parseAuditFindings } from './parse.js';
import { buildAiAuditFixPrompt, buildSecurityAuditPrompt } from './prompt.js';

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
});
