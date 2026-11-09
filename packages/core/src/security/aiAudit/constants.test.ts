import { describe, expect, it } from 'vitest';
import {
  AI_AUDIT_AGENTS,
  aiAuditAgentForCli,
  buildSecurityAuditInstallCommand,
  nodeMeetsAuditMinimum,
} from './constants.js';

describe('buildSecurityAuditInstallCommand', () => {
  it('is the documented skills.sh command for one agent', () => {
    expect(buildSecurityAuditInstallCommand(['claude-code'])).toBe(
      'npx -y skills add https://github.com/cloudflare/security-audit-skill --skill security-audit --agent claude-code -y',
    );
  });

  it('names every agent picked, once each', () => {
    expect(buildSecurityAuditInstallCommand(['claude-code', 'codex', 'claude-code'])).toBe(
      'npx -y skills add https://github.com/cloudflare/security-audit-skill --skill security-audit --agent claude-code codex -y',
    );
  });

  it('refuses an empty agent list and anything that is not an agent id', () => {
    expect(() => buildSecurityAuditInstallCommand([])).toThrow(/at least one/i);
    expect(() => buildSecurityAuditInstallCommand(['claude-code; rm -rf ~'])).toThrow(/agent/i);
  });
});

describe('aiAuditAgentForCli', () => {
  it('maps the CLIs that can run the audit to their skills CLI agent id', () => {
    expect(aiAuditAgentForCli('claude-code')?.skillsAgent).toBe('claude-code');
    expect(aiAuditAgentForCli('codex-cli')?.skillsAgent).toBe('codex');
    expect(aiAuditAgentForCli('aider')).toBeNull();
  });

  it('only lists agents that can spawn sub-agents, which the audit needs', () => {
    expect(AI_AUDIT_AGENTS.map((agent) => agent.cliId)).toEqual([
      'claude-code',
      'codex-cli',
      'opencode',
      'gemini-cli',
      'cursor-cli',
    ]);
  });
});

describe('nodeMeetsAuditMinimum', () => {
  it('needs Node 22.20 or later', () => {
    expect(nodeMeetsAuditMinimum('v22.20.0')).toBe(true);
    expect(nodeMeetsAuditMinimum('22.21.1')).toBe(true);
    expect(nodeMeetsAuditMinimum('v24.1.0')).toBe(true);
    expect(nodeMeetsAuditMinimum('v22.19.9')).toBe(false);
    expect(nodeMeetsAuditMinimum('v20.11.0')).toBe(false);
    expect(nodeMeetsAuditMinimum(null)).toBe(false);
    expect(nodeMeetsAuditMinimum('not a version')).toBe(false);
  });
});
