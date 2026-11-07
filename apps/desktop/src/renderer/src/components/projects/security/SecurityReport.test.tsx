import type { ScannerRunResult, SecurityScanRecord } from '@runova/core';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SecurityReport } from './SecurityReport';

/**
 * A report whose scanners never ran has nothing to say about the code. It must not show the
 * "Nothing serious found, 100/100" banner a clean scan gets.
 */

function run(over: Partial<ScannerRunResult>): ScannerRunResult {
  return {
    scannerId: 'semgrep',
    status: 'ok',
    transport: 'native',
    toolVersion: '1.0.0',
    findingCount: 0,
    durationMs: 1000,
    exitCode: 0,
    truncated: false,
    error: null,
    warnings: [],
    log: null,
    ...over,
  };
}

function record(over: Partial<SecurityScanRecord>): SecurityScanRecord {
  return {
    id: 'scan-1',
    projectId: 'p1',
    projectName: 'Shop',
    status: 'complete',
    verdict: 'safe',
    score: 100,
    findings: [],
    runs: [run({})],
    counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    durationMs: 1000,
    options: {
      scannerIds: ['semgrep'],
      semgrepConfig: 'auto',
      trivyScanners: ['vuln'],
      codeqlLanguage: null,
      codeqlBuildCommand: null,
      sonarProjectKey: null,
      includeInfo: false,
      maxFindingsPerScanner: 2000,
    },
    createdAt: '2026-11-01T10:00:00Z',
    ...over,
  };
}

describe('SecurityReport', () => {
  it('shows a clean scan as safe with its score', () => {
    renderWithProviders(<SecurityReport record={record({})} />);

    expect(screen.getByText('Nothing serious found')).toBeInTheDocument();
    expect(screen.getByText('Score 100/100')).toBeInTheDocument();
  });

  it('does not call a scan where every scanner failed safe', () => {
    renderWithProviders(
      <SecurityReport
        record={record({
          status: 'failed',
          runs: [run({ status: 'failed', error: 'semgrep: command not found' })],
        })}
      />,
    );

    expect(screen.getByText('The scan did not complete')).toBeInTheDocument();
    expect(screen.queryByText('Nothing serious found')).toBeNull();
    expect(screen.queryByText(/Score \d+\/100/)).toBeNull();
    expect(screen.getAllByText(/semgrep: command not found/).length).toBeGreaterThan(0);
  });

  it('does not call a cancelled scan with no findings safe', () => {
    renderWithProviders(
      <SecurityReport
        record={record({ status: 'cancelled', runs: [run({ status: 'cancelled' })] })}
      />,
    );

    expect(screen.getByText('The scan was cancelled')).toBeInTheDocument();
    expect(screen.queryByText(/Score \d+\/100/)).toBeNull();
  });
});
