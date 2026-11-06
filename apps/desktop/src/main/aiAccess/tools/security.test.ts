import type { SecurityFinding, SecurityScanRecord } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { AiTool, ToolContext } from '../registry';

function finding(over: Partial<SecurityFinding>): SecurityFinding {
  return {
    id: 'f1',
    scannerId: 'semgrep',
    ruleId: 'js.sql-injection',
    title: 'SQL injection',
    detail: 'User input reaches a query.',
    severity: 'high',
    nativeSeverity: 'ERROR',
    kind: 'sast',
    file: 'src/db.ts',
    line: 12,
    endLine: 12,
    excerpt: null,
    cwe: ['CWE-89'],
    owasp: [],
    cve: null,
    packageName: null,
    installedVersion: null,
    fixedVersion: null,
    helpUri: null,
    remediation: null,
    redacted: false,
    ...over,
  };
}

const record: SecurityScanRecord = {
  id: 'scan-2',
  projectId: 'p1',
  projectName: 'Shop',
  status: 'complete',
  verdict: 'risky',
  score: 61,
  findings: [
    finding({ id: 'f1', severity: 'high' }),
    finding({ id: 'f2', severity: 'info', title: 'Debug flag' }),
    finding({ id: 'f3', severity: 'low', title: 'Weak hash' }),
  ],
  runs: [
    {
      scannerId: 'semgrep',
      status: 'ok',
      transport: 'native',
      toolVersion: '1.90.0',
      findingCount: 3,
      durationMs: 5000,
      exitCode: 0,
      truncated: false,
      error: null,
      warnings: [],
      log: 'semgrep output that may hold anything',
    },
  ],
  counts: { critical: 0, high: 1, medium: 0, low: 1, info: 1 },
  durationMs: 5000,
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
};

const security = vi.hoisted(() => ({
  active: null as null | Record<string, unknown>,
  start: vi.fn(async (_projectId: string, _options: unknown, _runId: string) => ({})),
  cancel: vi.fn((_runId: string) => true),
}));

vi.mock('../../ipc/security', () => ({
  securityPreflight: async () => [
    { scannerId: 'semgrep', ready: true, requirements: [] },
    { scannerId: 'trivy', ready: true, requirements: [] },
    {
      scannerId: 'codeql',
      ready: false,
      requirements: [
        {
          id: 'binary',
          label: 'CodeQL installed',
          status: 'unmet',
          blocking: true,
          remedy: 'Install CodeQL from the Dev Tools page.',
          action: { kind: 'none' },
          detail: null,
        },
      ],
    },
    { scannerId: 'strix', ready: true, requirements: [] },
  ],
  startSecurityScan: security.start,
}));

vi.mock('../../security/scanRunner', () => ({
  getActiveScan: () => security.active,
  cancelSecurityScan: security.cancel,
  newScanRunId: () => 'run-1',
}));

vi.mock('../../securityScanDb', () => ({
  securityScanDb: {
    latest: (projectId: string) => (projectId === 'p1' ? record : null),
    get: (id: string) => (id === 'scan-2' ? record : null),
    list: () => [
      { ...record, findings: [] },
      { ...record, id: 'scan-1', verdict: 'dangerous', findings: [] },
    ],
  },
}));

/** Security tools: the scan report as the Security tab shows it, the scanners, and running one. */

const userData = useTempUserData();
const context: ToolContext = {
  projectId: 'p1',
  callerKind: 'runova',
  agent: 'Claude Code',
  cwd: null,
};
let tools: Map<string, AiTool>;

beforeEach(async () => {
  security.active = null;
  security.start.mockClear();
  security.cancel.mockClear();
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: 'C:/code/shop', createdAt: '2026-01-01T00:00:00Z' },
  ]);
  const { securityTools } = await import('./security');
  tools = new Map(securityTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

async function preview(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.preview(tool.input.parse(args), context);
}

describe('security tools', () => {
  it('gives the latest report without info findings or scanner logs, plus the history', async () => {
    const data = (await run('security_report')).data as Record<string, unknown>;
    expect(data).toMatchObject({
      running: null,
      report: {
        id: 'scan-2',
        verdict: 'risky',
        verdictLabel: 'Needs attention',
        score: 61,
        counts: { high: 1 },
      },
      history: [
        { id: 'scan-2', verdict: 'risky' },
        { id: 'scan-1', verdict: 'dangerous' },
      ],
    });
    const report = data.report as { findings: { id: string }[]; scanners: object[] };
    expect(report.findings.map((one) => one.id)).toEqual(['f1', 'f3']);
    expect(report.scanners[0]).not.toHaveProperty('log');

    const withInfo = (await run('security_report', { minSeverity: 'info', scanId: 'scan-2' }))
      .data as { report: { findings: unknown[] } };
    expect(withInfo.report.findings).toHaveLength(3);
    await expect(run('security_report', { scanId: 'nope' })).rejects.toThrow(/no scan/i);
  });

  it('says which scanners are ready and what the others need', async () => {
    const scanners = (await run('security_scanners')).data as Record<string, unknown>[];
    expect(scanners.find((one) => one.id === 'codeql')).toMatchObject({
      ready: false,
      needs: ['Install CodeQL from the Dev Tools page.'],
    });
    expect(scanners.find((one) => one.id === 'strix')).toMatchObject({ costsMoney: true });
  });

  it('starts a scan with the ready free scanners, the way the tab preselects them', async () => {
    const result = await run('security_run_scan');
    expect(security.start).toHaveBeenCalledWith(
      'p1',
      { scannerIds: ['semgrep', 'trivy'] },
      'run-1',
    );
    expect(result.text).toContain('security_report');
    expect((await preview('security_run_scan')).title).toBe('Run a security scan on Shop');
  });

  it('warns before a paid scanner and refuses one that is not ready', async () => {
    const shown = await preview('security_run_scan', { scannerIds: ['strix'] });
    expect(JSON.stringify(shown.fields)).toContain('API key');
    await expect(run('security_run_scan', { scannerIds: ['codeql'] })).rejects.toThrow(/not ready/);
    expect(security.start).not.toHaveBeenCalled();
  });

  it('will not start a second scan, and cancels the one that is running', async () => {
    security.active = {
      runId: 'run-9',
      projectId: 'p1',
      startedAt: Date.now(),
      scannerIds: ['semgrep'],
      scanners: [],
      completedScanners: 0,
      totalScanners: 1,
    };
    await expect(run('security_run_scan')).rejects.toThrow(/already running/);
    expect(((await run('security_report')).data as { running: unknown }).running).toMatchObject({
      runId: 'run-9',
      completedScanners: 0,
    });
    await run('security_cancel_scan');
    expect(security.cancel).toHaveBeenCalledWith('run-9');
    security.active = null;
    await expect(run('security_cancel_scan')).rejects.toThrow(/No security scan/);
  });
});
