import type { AiAuditProfile } from './constants.js';
import { AI_AUDIT_TRIAGE_FILE, auditFindingBucket } from './triage.js';
import {
  AI_AUDIT_SEVERITIES,
  AI_AUDIT_SEVERITY_LABEL,
  type AiAuditFinding,
  type AiAuditTriage,
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

/** A file inside a run folder, written with the folder's own separator. */
export function auditRunFilePath(outputDir: string, name: string): string {
  const separator = outputDir.includes('\\') ? '\\' : '/';
  return `${outputDir.replace(/[\\/]+$/, '')}${separator}${name}`;
}

function where(finding: AiAuditFinding): string {
  const sink = finding.trace.find((step) => step.kind === 'sink') ?? finding.trace.at(-1);
  return sink ? `${sink.file}:${sink.line}` : 'unknown location';
}

/** Findings the audit confirmed come first, worst first; ones confirmed since come after. */
function rank(finding: AiAuditFinding): number {
  return finding.verdict === 'confirmed'
    ? AI_AUDIT_SEVERITIES.indexOf(finding.severity.overall_severity)
    : AI_AUDIT_SEVERITIES.length;
}

/**
 * How an agent records what it settled, so the report moves the finding without anyone copying
 * results back by hand.
 */
function recordInstructions(outputDir: string, statuses: string): string {
  return [
    `Record each outcome as you go in ${auditRunFilePath(outputDir, AI_AUDIT_TRIAGE_FILE)}, so the Runova report moves the finding. The file is JSON shaped like {"findings": {"<fingerprint>": {"status": "fixed", "note": "..."}}}.`,
    'Create it if it is missing, keep every entry already in it, and only add or replace the entry for the finding you just settled.',
    `${statuses} The note says in a sentence or two what you found: the test that reproduces it, what the fix changed, or why it does not apply.`,
  ].join(' ');
}

export interface AiAuditPromptOptions {
  projectName: string;
  /** What has been decided since the run. Findings already fixed or ruled out are left out. */
  triage?: AiAuditTriage;
  /** The run folder, so the agent can record outcomes there and read full records from it. */
  outputDir?: string;
}

/**
 * Confirmed findings as a prompt an agent can work through, worst first: the ones the audit
 * confirmed plus any proven real since. Fixed, ruled out, rejected and unverified ones are left
 * out.
 */
export function buildAiAuditFixPrompt(
  findings: readonly AiAuditFinding[],
  options: AiAuditPromptOptions,
): string {
  const triage = options.triage ?? {};
  const confirmed = findings
    .filter((finding) => auditFindingBucket(finding, triage) === 'confirmed')
    .sort((a, b) => rank(a) - rank(b));
  if (confirmed.length === 0) return '';

  const sections = confirmed.map((finding, index) => {
    if (finding.verdict !== 'confirmed') {
      const note = triage[finding.fingerprint]?.note;
      const lines = [
        `## ${index + 1}. [Confirmed after the audit] ${finding.title}`,
        `Fingerprint: ${finding.fingerprint}`,
        `Where: ${where(finding)}`,
      ];
      if (finding.claimed_root_cause) lines.push(`Root cause: ${finding.claimed_root_cause}`);
      if (finding.description) lines.push(`What happens: ${finding.description}`);
      if (note) lines.push(`How it was confirmed: ${note}`);
      return lines.join('\n');
    }
    const lines = [
      `## ${index + 1}. [${AI_AUDIT_SEVERITY_LABEL[finding.severity.overall_severity]}] ${finding.title}`,
      `Fingerprint: ${finding.fingerprint}`,
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
    `A Cloudflare security-audit run on ${options.projectName} turned up the confirmed findings below. Each one was reproduced by the audit and re-checked by a separate agent, or proven real since.`,
    'Fix them worst first. Keep each fix small and focused, add a regression test where the project has tests, and do not change unrelated code. Tell me if a finding turns out not to apply.',
    ...(options.outputDir
      ? [
          recordInstructions(
            options.outputDir,
            'status is "fixed" once the fix is in, or "not_a_bug" if the finding turns out not to apply.',
          ),
        ]
      : []),
    '',
    ...sections,
  ].join('\n\n');
}

/** Up to this many findings are written out in full; past it the prompt points at findings.json. */
export const AI_AUDIT_FULL_DETAIL_LIMIT = 3;

/**
 * Unverified findings as a prompt to settle them: prove each one with a test, fix the real ones,
 * and say why the others do not apply. Ones already settled since the run are left out.
 */
export function buildAiAuditValidationPrompt(
  findings: readonly AiAuditFinding[],
  options: AiAuditPromptOptions,
): string {
  const triage = options.triage ?? {};
  const pending = findings.filter(
    (finding) =>
      finding.verdict === 'needs_validation' &&
      auditFindingBucket(finding, triage) === 'needs_validation',
  );
  if (pending.length === 0) return '';
  const full = pending.length <= AI_AUDIT_FULL_DETAIL_LIMIT || !options.outputDir;

  const sections = pending.map((finding, index) => {
    const lines = [
      `## ${index + 1}. ${finding.title}`,
      `Fingerprint: ${finding.fingerprint}`,
      `Where: ${where(finding)}`,
    ];
    if (finding.verdict !== 'needs_validation') return lines.join('\n');
    if (finding.claimed_root_cause) lines.push(`Claimed root cause: ${finding.claimed_root_cause}`);
    if (!full) return lines.join('\n');
    if (finding.description) lines.push(`What happens: ${finding.description}`);
    if (finding.trace.length > 0) {
      const path = finding.trace
        .map((step) => `${step.file}:${step.line}${step.scope ? ` (${step.scope})` : ''}`)
        .join(' -> ');
      lines.push(`Path: ${path}`);
    }
    for (const blocker of finding.blockers) lines.push(`Still unknown: ${blocker}`);
    if (finding.validation_plan.local) {
      lines.push(`How to check it locally: ${finding.validation_plan.local}`);
    }
    if (finding.validation_plan.deployment) {
      lines.push(`How to check it in a deployment: ${finding.validation_plan.deployment}`);
    }
    return lines.join('\n');
  });

  const one = pending.length === 1;
  return [
    `A Cloudflare security-audit run on ${options.projectName} left ${one ? 'the finding below' : `the ${pending.length} findings below`} unproven: the audit could not run the code, so it could not tell whether ${one ? 'it is' : 'they are'} real. You can. This is my own checkout, so run its tests and local tooling as you need, but do not contact deployed services or shared infrastructure.`,
    [
      one ? 'Work through it like this:' : 'Work through them one at a time:',
      '1. Read the code along the path and decide whether the claim holds.',
      '2. If it looks real, prove it with a focused failing test, or a local reproduction where the project has no tests.',
      '3. If it is real, fix it with a small change and keep the test as a regression test. If it is not real, change nothing and say why.',
    ].join('\n'),
    ...(full || !options.outputDir
      ? []
      : [
          `Each finding's full record (trace, evidence, what is still unknown and how to check it) is in ${auditRunFilePath(options.outputDir, 'findings.json')}, under the same fingerprint. Read it before you start on a finding.`,
        ]),
    ...(options.outputDir
      ? [
          recordInstructions(
            options.outputDir,
            'status is "fixed" (real, and you fixed it), "confirmed" (real, but you left the fix to me) or "not_a_bug" (it does not apply).',
          ),
        ]
      : []),
    one
      ? 'Finish with a short summary of what you found and changed.'
      : 'Finish with a short summary: which findings were real and fixed, which were real but left for me, and which did not apply.',
    '',
    ...sections,
  ].join('\n\n');
}
