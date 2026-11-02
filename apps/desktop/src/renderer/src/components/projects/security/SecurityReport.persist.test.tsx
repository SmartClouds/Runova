import type { SecurityFinding, SecurityScanRecord } from '@runova/core';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProjectUiScope } from '@/hooks/useProjectUiState';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SecurityReport } from './SecurityReport';

/**
 * Leaving the project details page unmounts the report, so the filters someone narrowed it with
 * have to be there again when they come back to it.
 */

function finding(overrides: Partial<SecurityFinding>): SecurityFinding {
  return {
    id: 'f1',
    scannerId: 'semgrep',
    ruleId: 'rule.one',
    title: 'Hard-coded secret',
    detail: '',
    severity: 'high',
    nativeSeverity: null,
    kind: 'code',
    file: 'src/auth.ts',
    line: 3,
    endLine: null,
    excerpt: null,
    cwe: [],
    owasp: [],
    cve: null,
    packageName: null,
    installedVersion: null,
    fixedVersion: null,
    helpUri: null,
    ...overrides,
  } as SecurityFinding;
}

const record = {
  id: 'scan-1',
  projectId: 'p1',
  projectName: 'Apollo',
  status: 'complete',
  verdict: 'caution',
  score: 70,
  findings: [
    finding({ id: 'f1', title: 'Hard-coded secret', severity: 'high', file: 'src/auth.ts' }),
    finding({
      id: 'f2',
      title: 'Outdated lodash',
      severity: 'low',
      scannerId: 'trivy',
      file: 'package-lock.json',
    }),
  ],
  runs: [],
  counts: { critical: 0, high: 1, medium: 0, low: 1, info: 0 },
  durationMs: 4000,
  options: {},
  createdAt: '2026-11-01T10:00:00.000Z',
} as unknown as SecurityScanRecord;

function renderReport(projectId = 'p1') {
  return renderWithProviders(
    <ProjectUiScope.Provider value={projectId}>
      <SecurityReport record={record} />
    </ProjectUiScope.Provider>,
  );
}

describe('SecurityReport after leaving and coming back', () => {
  it('keeps the severity the findings were narrowed to', async () => {
    const first = renderReport();
    await first.user.click(screen.getByRole('button', { name: 'High 1' }));
    expect(screen.queryByText('Outdated lodash')).not.toBeInTheDocument();
    first.unmount();

    renderReport();

    expect(screen.getByText('Hard-coded secret')).toBeInTheDocument();
    expect(screen.queryByText('Outdated lodash')).not.toBeInTheDocument();
  });

  it('keeps what was typed in the filter box', async () => {
    const first = renderReport();
    await first.user.type(screen.getByPlaceholderText('Filter by file or rule...'), 'lock');
    first.unmount();

    renderReport();

    expect(screen.getByPlaceholderText('Filter by file or rule...')).toHaveValue('lock');
    expect(screen.getByText('Outdated lodash')).toBeInTheDocument();
    expect(screen.queryByText('Hard-coded secret')).not.toBeInTheDocument();
  });

  it('shows every finding for another project', async () => {
    const first = renderReport('p1');
    await first.user.click(screen.getByRole('button', { name: 'High 1' }));
    first.unmount();

    renderReport('p2');

    expect(screen.getByText('Hard-coded secret')).toBeInTheDocument();
    expect(screen.getByText('Outdated lodash')).toBeInTheDocument();
  });

  it('forgets the filters outside a project, as it always did', async () => {
    const first = renderWithProviders(<SecurityReport record={record} />);
    await first.user.click(screen.getByRole('button', { name: 'High 1' }));
    first.unmount();

    renderWithProviders(<SecurityReport record={record} />);

    expect(screen.getByText('Outdated lodash')).toBeInTheDocument();
  });
});
