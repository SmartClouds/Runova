import type { AiAuditFinding, AiAuditRunDetail } from '@runova/core';
import { parseAuditFindings } from '@runova/core';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { AiAuditReport } = await import('./AiAuditReport');

/**
 * The finished audit: confirmed findings first, the unproven and the disproved one tab away, and
 * every finding opens up into the trace, the proof and the fix.
 */

const trace = [
  {
    kind: 'entrypoint',
    file: 'src/routes/users.ts',
    line: 12,
    scope: 'GET /users',
    description: 'q is read.',
  },
  {
    kind: 'sink',
    file: 'src/db/users.ts',
    line: 42,
    scope: 'searchUsers',
    description: 'q reaches db.query.',
  },
];

function confirmed(fingerprint: string, title: string, severity: string) {
  return {
    verdict: 'confirmed',
    fingerprint,
    title,
    description: `${title} description.`,
    root_cause: 'String concatenation.',
    intended_behavior: 'Data stays data.',
    trace,
    evidence: [{ file: 'src/db/users.ts', line: 42, description: 'db.query(`${q}`)' }],
    conditions: [{ kind: 'authentication_level', description: 'Any signed-in user.' }],
    execution: {
      attacker_perspective: 'A signed-in user.',
      payloads: ["' OR 1=1 --"],
      instructions: ['Send the payload as q.'],
      observed_result: 'Every row comes back.',
    },
    remediation: {
      strategy: 'Use a parameterized query.',
      code_changes: [{ file_name: 'src/db/users.ts', fixed_code: 'db.query(sql, [q])' }],
    },
    severity: {
      likelihood: { score: 'high', reason: '' },
      impact: { score: severity, reason: '' },
      overall_severity: severity,
    },
    confidence: { score: 'high', reason: 'Reproduced.' },
  };
}

const findings: AiAuditFinding[] = parseAuditFindings([
  confirmed('sqli:1', 'SQL injection in user search', 'high'),
  confirmed('rce:1', 'Command injection in admin runner', 'critical'),
  confirmed('hdr:1', 'Missing security headers', 'low'),
  {
    verdict: 'needs_validation',
    fingerprint: 'ssrf:1',
    title: 'Possible SSRF in the image proxy',
    description: '',
    claimed_root_cause: 'No allow list.',
    trace,
    evidence: [],
    blockers: ['Deployment egress rules are unknown.'],
    validation_plan: { deployment: 'Fetch the metadata IP through it.' },
  },
  {
    verdict: 'rejected',
    fingerprint: 'xss:1',
    title: 'XSS in the profile view',
    description: '',
    claimed_root_cause: 'Unescaped output.',
    trace,
    evidence: [],
    reason: 'React escapes text children.',
  },
]).findings;

function detail(over: Partial<AiAuditRunDetail> = {}): AiAuditRunDetail {
  return {
    runName: 'run-1',
    outputDir: '/home/me/security-audit-skill/shop/run-1',
    phase: 'complete',
    metadata: { runStatus: 'complete', incompleteReason: null, profile: 'standard', target: null },
    counts: {
      confirmed: 3,
      needsValidation: 1,
      rejected: 1,
      bySeverity: { critical: 1, high: 1, medium: 0, low: 1, informational: 0 },
    },
    ledger: { total: 12, settled: 12, byStatus: { covered: 10, out_of_scope: 2 } },
    startedAt: '2026-11-08T10:00:00Z',
    lastActivityAt: '2026-11-08T11:00:00Z',
    hasReport: true,
    findings,
    droppedFindings: 0,
    report: '# Report',
    ...over,
  };
}

function setup(run = detail()) {
  const onOpenFile = vi.fn();
  const onFixWithAgent = vi.fn();
  const view = renderWithProviders(
    <AiAuditReport
      run={run}
      projectName="Shop"
      onOpenFile={onOpenFile}
      onFixWithAgent={onFixWithAgent}
    />,
  );
  return { ...view, onOpenFile, onFixWithAgent };
}

describe('AiAuditReport', () => {
  it('leads with confirmed findings, worst first, and counts every verdict', () => {
    setup();

    expect(screen.getByRole('tab', { name: /Confirmed 3/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /Needs validation 1/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Rejected 1/ })).toBeInTheDocument();
    const titles = screen
      .getAllByRole('button', { name: /injection|headers/ })
      .map((el) => el.textContent ?? '');
    expect(titles[0]).toMatch(/Command injection/);
    expect(titles[1]).toMatch(/SQL injection/);
    expect(titles[2]).toMatch(/Missing security headers/);
  });

  it('switches to the findings that still need validating, and to the rejected ones', async () => {
    const { user } = setup();

    await user.click(screen.getByRole('tab', { name: /Needs validation/ }));
    expect(screen.getByText('Possible SSRF in the image proxy')).toBeInTheDocument();
    expect(screen.queryByText('SQL injection in user search')).toBeNull();

    await user.click(screen.getByRole('tab', { name: /Rejected/ }));
    expect(screen.getByText('XSS in the profile view')).toBeInTheDocument();
  });

  it('narrows by severity and by search', async () => {
    const { user } = setup();

    await user.click(screen.getByRole('button', { name: /^Critical 1/ }));
    expect(screen.getByText('Command injection in admin runner')).toBeInTheDocument();
    expect(screen.queryByText('SQL injection in user search')).toBeNull();

    await user.click(screen.getByRole('button', { name: /^Critical 1/ }));
    await user.type(screen.getByPlaceholderText(/Filter by title or file/), 'headers');
    expect(screen.getByText('Missing security headers')).toBeInTheDocument();
    expect(screen.queryByText('Command injection in admin runner')).toBeNull();
  });

  it('opens a finding into its trace, proof and fix, and opens trace files', async () => {
    const { user, onOpenFile } = setup();

    await user.click(screen.getByRole('button', { name: /SQL injection in user search/ }));
    const card = screen.getByRole('region', { name: 'SQL injection in user search' });

    expect(within(card).getByText('String concatenation.')).toBeInTheDocument();
    expect(within(card).getByText("' OR 1=1 --")).toBeInTheDocument();
    expect(within(card).getByText('Use a parameterized query.')).toBeInTheDocument();
    expect(within(card).getByText('db.query(sql, [q])')).toBeInTheDocument();

    // The sink appears in the trace and again as evidence; the first is the trace step.
    await user.click(within(card).getAllByRole('button', { name: 'src/db/users.ts:42' })[0]);
    expect(onOpenFile).toHaveBeenCalledWith('src/db/users.ts', 42);
  });

  it('copies a fix prompt and hands the findings to an agent', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const { user, onFixWithAgent } = setup();

    await user.click(screen.getByRole('button', { name: /Copy fix prompt/ }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Command injection'));

    await user.click(screen.getByRole('button', { name: /Fix with agent/ }));
    expect(onFixWithAgent).toHaveBeenCalledWith(expect.stringContaining('SQL injection'));
  });

  it('has nothing to fix when nothing was confirmed', () => {
    setup(
      detail({
        findings: findings.filter((f) => f.verdict !== 'confirmed'),
        counts: {
          confirmed: 0,
          needsValidation: 1,
          rejected: 1,
          bySeverity: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 },
        },
      }),
    );

    expect(screen.getByRole('button', { name: /Fix with agent/ })).toBeDisabled();
    expect(screen.getByText(/No confirmed findings/)).toBeInTheDocument();
  });

  it('says why a run stopped early', () => {
    setup(
      detail({
        phase: 'incomplete',
        metadata: {
          runStatus: 'incomplete',
          incompleteReason: 'validation_budget_exhausted',
          profile: 'standard',
          target: null,
        },
      }),
    );

    expect(screen.getByText(/stopped before it finished/i)).toBeInTheDocument();
    expect(screen.getByText(/validation budget exhausted/i)).toBeInTheDocument();
  });

  it('mentions records it could not read', () => {
    setup(detail({ droppedFindings: 2 }));

    expect(screen.getByText(/2 records in findings.json could not be read/)).toBeInTheDocument();
  });
});
