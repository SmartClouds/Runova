import type { AiAuditProfile } from './constants.js';
import {
  AI_AUDIT_SEVERITIES,
  AI_AUDIT_SEVERITY_LABEL,
  type AiAuditConfirmedFinding,
  type AiAuditFinding,
} from './types.js';

/**
 * What the agent is sent to start an audit. It names the skill so the agent loads it, asks for
 * full audit mode (the one that writes artifacts), and pins the output folder Runova watches.
 */
export function buildSecurityAuditPrompt(input: {
  outputDir: string;
  profile: AiAuditProfile;
  scopePaths: readonly string[];
}): string {
  const scope =
    input.scopePaths.length > 0
      ? `Only these paths: ${input.scopePaths.join(', ')}`
      : 'The whole repository';
  return [
    'Use the security-audit skill to run a full security audit of this repository, in full audit mode with report artifacts.',
    '',
    `- Profile: ${input.profile}`,
    `- Scope: ${scope}`,
    `- Output directory: ${input.outputDir}`,
    '',
    'Write every run artifact (run-metadata.json, coverage-ledger.json, findings.json, REPORT.md and the rest) into that output directory, and nowhere inside this repository.',
    'Work through all six phases without stopping to ask me questions unless you are truly blocked, and finish by setting run_status in run-metadata.json to complete or incomplete.',
  ].join('\n');
}

function where(finding: AiAuditConfirmedFinding): string {
  const sink = finding.trace.find((step) => step.kind === 'sink') ?? finding.trace.at(-1);
  return sink ? `${sink.file}:${sink.line}` : 'unknown location';
}

/**
 * Confirmed findings as a prompt an agent can work through, worst first. Unverified and rejected
 * records are left out: the first are not proven and the second were disproved.
 */
export function buildAiAuditFixPrompt(
  findings: readonly AiAuditFinding[],
  options: { projectName: string },
): string {
  const confirmed = findings
    .filter((finding): finding is AiAuditConfirmedFinding => finding.verdict === 'confirmed')
    .sort(
      (a, b) =>
        AI_AUDIT_SEVERITIES.indexOf(a.severity.overall_severity) -
        AI_AUDIT_SEVERITIES.indexOf(b.severity.overall_severity),
    );
  if (confirmed.length === 0) return '';

  const sections = confirmed.map((finding, index) => {
    const lines = [
      `## ${index + 1}. [${AI_AUDIT_SEVERITY_LABEL[finding.severity.overall_severity]}] ${finding.title}`,
      `Where: ${where(finding)}`,
    ];
    if (finding.root_cause) lines.push(`Root cause: ${finding.root_cause}`);
    if (finding.description) lines.push(`What happens: ${finding.description}`);
    if (finding.remediation.strategy) lines.push(`Fix: ${finding.remediation.strategy}`);
    for (const change of finding.remediation.code_changes ?? []) {
      lines.push(`Suggested change in ${change.file_name}:`, '```', change.fixed_code, '```');
    }
    return lines.join('\n');
  });

  return [
    `A Cloudflare security-audit run on ${options.projectName} confirmed the findings below. Each one was reproduced and then re-checked by a separate agent.`,
    'Fix them worst first. Keep each fix small and focused, add a regression test where the project has tests, and do not change unrelated code. Tell me if a finding turns out not to apply.',
    '',
    ...sections,
  ].join('\n\n');
}
