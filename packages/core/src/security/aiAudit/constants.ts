import { SKILLS_CLI_AGENTS } from '../../skills/skillsCliAgents.js';

/**
 * Cloudflare's security-audit skill (MIT): a six phase audit an agent runs against the project,
 * where every candidate finding is handed to a fresh agent that tries to disprove it.
 */
export const SECURITY_AUDIT_REPO_URL = 'https://github.com/cloudflare/security-audit-skill';
export const SECURITY_AUDIT_SKILL_NAME = 'security-audit';
/** The skills CLI needs this, and so do the skill's own validators. */
export const SECURITY_AUDIT_MIN_NODE = '22.20.0';
/** The skill's own default home for runs: ~/security-audit-skill/<repo>/run-<N>. */
export const SECURITY_AUDIT_RUNS_FOLDER = 'security-audit-skill';

export type AiAuditProfile = 'quick' | 'standard' | 'deep';

export const AI_AUDIT_PROFILES: {
  value: AiAuditProfile;
  label: string;
  estimate: string;
  description: string;
}[] = [
  {
    value: 'quick',
    label: 'Quick',
    estimate: 'About 20 to 40 minutes',
    description: 'The riskiest surfaces only. A good first look at a new project.',
  },
  {
    value: 'standard',
    label: 'Standard',
    estimate: 'About 45 to 90 minutes',
    description: "The skill's default: every entry point it finds, each finding verified.",
  },
  {
    value: 'deep',
    label: 'Deep',
    estimate: 'Two hours or more',
    description: 'Wider attack classes and more validation. Spends the most tokens.',
  },
];

/**
 * The agent CLIs that can run the audit. It needs tool use and parallel sub-agents, which these
 * have; each maps to the agent id the skills CLI installs for.
 */
export const AI_AUDIT_AGENTS: readonly { cliId: string; skillsAgent: string }[] = [
  'claude-code',
  'codex-cli',
  'opencode',
  'gemini-cli',
  'cursor-cli',
].flatMap((cliId) => {
  const agent = SKILLS_CLI_AGENTS.find((entry) => entry.cliId === cliId);
  return agent ? [{ cliId, skillsAgent: agent.value }] : [];
});

export function aiAuditAgentForCli(cliId: string): { cliId: string; skillsAgent: string } | null {
  return AI_AUDIT_AGENTS.find((agent) => agent.cliId === cliId) ?? null;
}

const AGENT_ID = /^[a-z0-9][a-z0-9.-]*$/;

/**
 * The install command skills.sh documents, scoped to the project (no --global) and to the agents
 * picked. -y skips the CLI's prompts, since the agents are already chosen in the wizard.
 */
export function buildSecurityAuditInstallCommand(agents: readonly string[]): string {
  const unique = [...new Set(agents)];
  if (unique.length === 0) throw new Error('Pick at least one agent to install the skill for.');
  const bad = unique.find((agent) => !AGENT_ID.test(agent));
  if (bad) throw new Error(`Not an agent id: ${bad}`);
  return `npx skills add ${SECURITY_AUDIT_REPO_URL} --skill ${SECURITY_AUDIT_SKILL_NAME} --agent ${unique.join(' ')} -y`;
}

export function nodeMeetsAuditMinimum(version: string | null): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  const [needMajor, needMinor, needPatch] = SECURITY_AUDIT_MIN_NODE.split('.').map(Number);
  if (major !== needMajor) return major > needMajor;
  if (minor !== needMinor) return minor > needMinor;
  return patch >= needPatch;
}
