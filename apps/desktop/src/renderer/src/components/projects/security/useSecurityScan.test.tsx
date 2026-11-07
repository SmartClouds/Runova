import type { ScannerPreflight, SecurityScanRecord } from '@runova/core';
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { renderHookWithProviders } from '../../../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { useSecurityScan } = await import('./useSecurityScan');

/**
 * The Security tab's data layer, driven the way the tab drives it.
 */

const ready = (scannerId: ScannerPreflight['scannerId']): ScannerPreflight => ({
  scannerId,
  ready: true,
  requirements: [],
});
const notReady = (scannerId: ScannerPreflight['scannerId']): ScannerPreflight => ({
  scannerId,
  ready: false,
  requirements: [],
});

function record(over: Partial<SecurityScanRecord> = {}): SecurityScanRecord {
  return {
    id: 'scan-1',
    projectId: 'p1',
    projectName: 'Shop',
    status: 'complete',
    verdict: 'safe',
    score: 100,
    findings: [],
    runs: [],
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

function setup(bridge: Record<string, unknown> = {}) {
  return renderHookWithProviders(() => useSecurityScan('p1'), {
    bridge: {
      'security.preflight': [ready('semgrep'), ready('trivy')],
      'security.latest': null,
      'security.getConfig': {},
      ...bridge,
    },
  });
}

describe('useSecurityScan', () => {
  it('only ever selects scanners that are ready', async () => {
    const { result, bridge } = setup();
    await waitFor(() => expect(result.current.selection).toEqual(['semgrep', 'trivy']));
    // The user narrows the scan to Trivy, which saves the selection.
    act(() => result.current.toggleScanner('semgrep'));
    expect(result.current.selection).toEqual(['trivy']);

    // Trivy was uninstalled since the selection was made.
    bridge.$set('security.preflight', [ready('semgrep'), notReady('trivy')]);
    await act(() => result.current.refreshPreflight());

    await waitFor(() => expect(result.current.selection).toEqual([]));
  });

  it('asks main for a fresh check on refresh', async () => {
    const { result, bridge } = setup();
    await waitFor(() => expect(result.current.preflightLoading).toBe(false));

    await act(() => result.current.refreshPreflight());

    expect(bridge.$fn('security.preflight')).toHaveBeenLastCalledWith('p1', { force: true });
  });

  it('runs only the ready scanners it shows as selected', async () => {
    const { result, bridge } = setup({
      'security.preflight': [ready('semgrep'), notReady('trivy')],
      'security.runScan': record(),
    });
    await waitFor(() => expect(result.current.selection).toEqual(['semgrep']));

    await act(async () => result.current.runScan());

    expect(bridge.$fn('security.runScan')).toHaveBeenCalledWith(
      'p1',
      { scannerIds: ['semgrep'] },
      expect.any(String),
    );
  });

  it('does not show a cancelled empty run as the latest report', async () => {
    const previous = record({ id: 'scan-0', score: 72, verdict: 'caution' });
    const { result } = setup({
      'security.latest': previous,
      'security.runScan': record({ id: 'scan-2', status: 'cancelled' }),
    });
    await waitFor(() => expect(result.current.report?.id).toBe('scan-0'));

    await act(async () => result.current.runScan());

    await waitFor(() => expect(result.current.running).toBe(false));
    expect(result.current.report?.id).toBe('scan-0');
    expect(toast.info).toHaveBeenCalledWith('Scan cancelled.');
  });

  it('picks up a scan that something else started', async () => {
    const { result, bridge } = setup();
    await waitFor(() => expect(result.current.preflightLoading).toBe(false));
    expect(result.current.running).toBe(false);

    bridge.$set('security.activeScan', {
      runId: 'agent-run',
      projectId: 'p1',
      startedAt: Date.now(),
      scannerIds: ['semgrep'],
      scanners: [],
      completedScanners: 0,
      totalScanners: 1,
    });
    act(() =>
      bridge.$emit('security.onScanProgress', {
        runId: 'agent-run',
        projectId: 'p1',
        scannerId: 'semgrep',
        phase: 'scanning',
        message: 'Scanning',
        completedScanners: 0,
        totalScanners: 1,
        elapsedMs: 10,
      }),
    );

    await waitFor(() => expect(result.current.running).toBe(true));
    expect(result.current.runScannerIds).toEqual(['semgrep']);
  });

  it('shows an old scan without replacing the latest one', async () => {
    const latest = record({ id: 'scan-latest' });
    const old = record({ id: 'scan-old', createdAt: '2026-10-01T10:00:00Z' });
    const { result, queryClient } = setup({
      'security.latest': latest,
      'security.getScan': old,
    });
    await waitFor(() => expect(result.current.report?.id).toBe('scan-latest'));

    await act(() => result.current.viewScan('scan-old'));

    await waitFor(() => expect(result.current.report?.id).toBe('scan-old'));
    expect(result.current.viewingOldScan).toBe(true);
    expect(queryClient.getQueryData(queryKeys.securityLatest('p1'))).toEqual(latest);

    act(() => result.current.backToLatest());
    expect(result.current.report?.id).toBe('scan-latest');
  });

  it('deletes a scan from the history', async () => {
    const { result, bridge } = setup({
      'security.history': [record({ id: 'scan-old' })],
    });
    await waitFor(() => expect(result.current.history).toHaveLength(1));
    bridge.$set('security.history', []);

    await act(() => result.current.deleteScan('scan-old'));

    expect(bridge.$fn('security.deleteScan')).toHaveBeenCalledWith('scan-old');
    await waitFor(() => expect(result.current.history).toHaveLength(0));
  });

  it('says so when saving settings fails', async () => {
    const { result } = setup({
      'security.setConfig': async () => {
        throw new Error('disk full');
      },
    });

    await act(async () => {
      result.current.saveConfig.mutate({ semgrepConfig: 'p/ci' });
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/disk full/)),
    );
  });

  it('reports a failed preflight instead of an empty one', async () => {
    const { result } = setup({
      'security.preflight': async () => {
        throw new Error('probe crashed');
      },
    });

    await waitFor(() => expect(result.current.preflightError).toMatch(/probe crashed/));
  });
});
