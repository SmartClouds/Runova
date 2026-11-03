import type { AiAccessApproval } from '../../shared/aiAccessTypes';

/**
 * An approval as plain text, for a CLI that asks the user itself (MCP elicitation). It carries the
 * same facts as the Runova window. Secret values are masked: a terminal is easier to share or
 * record than a dialog, and the window is where the user can choose to see them.
 */

const MASK = '••••••';
const RISK_LABELS = { read: 'Read only', write: 'Changes something', sensitive: 'Sensitive' };

/** "KEY=value" becomes "KEY=••••••"; any other line is masked whole. */
function maskLine(line: string): string {
  const match = /^(\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*=)/.exec(line);
  return match ? `${match[1]}${MASK}` : MASK;
}

function lineChanges(before: string, after: string): { added: string[]; removed: string[] } {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  return {
    removed: beforeLines.filter((line) => line.trim() && !afterSet.has(line)),
    added: afterLines.filter((line) => line.trim() && !beforeSet.has(line)),
  };
}

export function approvalText(
  approval: Pick<AiAccessApproval, 'agent' | 'toolTitle' | 'risk' | 'projectName' | 'preview'>,
): string {
  const { preview } = approval;
  const lines = [`${approval.agent} wants to: ${preview.title}`];
  const where = approval.projectName ? `Project: ${approval.projectName} · ` : '';
  lines.push(`${where}${RISK_LABELS[approval.risk]}`);
  if (preview.summary) lines.push(preview.summary);

  if (preview.fields?.length) {
    lines.push('');
    for (const field of preview.fields) {
      lines.push(`${field.label}: ${field.secret ? MASK : field.value}`);
    }
  }

  if (preview.request) {
    lines.push('', `${preview.request.method} ${preview.request.url}`);
    for (const header of preview.request.headers ?? []) {
      lines.push(`${header.key}: ${header.value}`);
    }
    if (preview.request.body) lines.push('', preview.request.body);
  }

  if (preview.diff) {
    const { added, removed } = lineChanges(preview.diff.before, preview.diff.after);
    const show = (line: string) => (preview.diff?.secret ? maskLine(line) : line);
    lines.push(
      '',
      `Changes to ${preview.diff.fileName} (${added.length} added, ${removed.length} removed):`,
    );
    for (const line of removed) lines.push(`- ${show(line)}`);
    for (const line of added) lines.push(`+ ${show(line)}`);
  }

  return lines.join('\n');
}
