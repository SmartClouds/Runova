import type {
  ScannerPreflight,
  SecurityFinding,
  SecurityScannerId,
  SecurityScanOptions,
  SecurityScanProgress,
} from '@runova/core';
import { DEFAULT_SCAN_OPTIONS } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../test/main/ipcHarness';
import type { AdapterOutcome, ScanContext } from './adapters';

/**
 * One scan from start to record, with the scanners themselves replaced. What matters here is the
 * orchestration: each scanner is checked again right before it starts, a scanner that blows up
 * does not take the other scanners' findings with it, and every scanner the run never got to
 * still reports where it ended up.
 */

function ready(scannerId: SecurityScannerId): ScannerPreflight {
  return { scannerId, ready: true, requirements: [] };
}

function blocked(scannerId: SecurityScannerId, remedy: string): ScannerPreflight {
  return {
    scannerId,
    ready: false,
    requirements: [
      {
        id: 'docker-running',
        label: 'Docker is available',
        status: 'unmet',
        blocking: true,
        remedy,
        action: { kind: 'start-docker' },
        detail: null,
      },
    ],
  };
}

function finding(scannerId: SecurityScannerId, id: string): SecurityFinding {
  return {
    id,
    scannerId,
    ruleId: 'rule',
    title: `Finding ${id}`,
    detail: '',
    severity: 'high',
    nativeSeverity: 'ERROR',
    kind: 'sast',
    file: 'src/app.ts',
    line: 1,
    endLine: 1,
    excerpt: null,
    cwe: [],
    owasp: [],
    cve: null,
    packageName: null,
    installedVersion: null,
    fixedVersion: null,
    helpUri: null,
    remediation: null,
    redacted: false,
  };
}

function outcome(findings: SecurityFinding[] = []): AdapterOutcome {
  return {
    findings,
    exitCode: 0,
    truncated: false,
    warnings: [],
    transport: 'native',
    toolVersion: '1.0.0',
    log: '',
    timedOut: false,
    cancelled: false,
    error: null,
  };
}

const mocks = vi.hoisted(() => ({
  checkAllPreflight: vi.fn(),
  checkScannerPreflight: vi.fn(),
  run: vi.fn(),
  progress: [] as SecurityScanProgress[],
  saved: [] as unknown[],
}));

vi.mock('./preflight', () => ({
  checkAllPreflight: mocks.checkAllPreflight,
  checkScannerPreflight: mocks.checkScannerPreflight,
  clearPreflightCache: vi.fn(),
}));

vi.mock('./adapters', () => {
  const adapter = (id: string) => ({
    id,
    timeoutMs: 1000,
    run: (ctx: ScanContext) => mocks.run(ctx),
  });
  return {
    SCANNER_ADAPTERS: {
      semgrep: adapter('semgrep'),
      trivy: adapter('trivy'),
      bearer: adapter('bearer'),
      sonarqube: adapter('sonarqube'),
      codeql: adapter('codeql'),
      strix: adapter('strix'),
    },
  };
});

vi.mock('../ipc/send', () => ({
  broadcastToWindows: (_channel: string, payload: SecurityScanProgress) => {
    mocks.progress.push(payload);
  },
}));

vi.mock('../securityScanDb', () => ({
  securityScanDb: { add: (record: unknown) => mocks.saved.push(record) },
}));

useTempUserData();

function options(scannerIds: SecurityScannerId[]): SecurityScanOptions {
  return { ...DEFAULT_SCAN_OPTIONS, scannerIds };
}

async function runScan(scannerIds: SecurityScannerId[], runId = 'run-12345678') {
  const { runSecurityScan } = await import('./scanRunner');
  return runSecurityScan(runId, {
    projectId: 'p1',
    projectName: 'Shop',
    projectPath: '/work/shop',
    options: options(scannerIds),
    config: {},
  });
}

beforeEach(() => {
  mocks.progress.length = 0;
  mocks.saved.length = 0;
  mocks.run.mockReset();
  mocks.checkAllPreflight.mockReset();
  mocks.checkScannerPreflight.mockReset();
  mocks.checkAllPreflight.mockImplementation(async () =>
    (['semgrep', 'trivy', 'bearer', 'sonarqube', 'codeql', 'strix'] as const).map(ready),
  );
  mocks.checkScannerPreflight.mockImplementation(async (scannerId: SecurityScannerId) =>
    ready(scannerId),
  );
});

describe('runSecurityScan', () => {
  it('checks each scanner again right before it starts', async () => {
    mocks.run.mockImplementation(async (ctx: ScanContext) =>
      outcome([finding(ctx.scannerId, `${ctx.scannerId}-1`)]),
    );
    // Docker went away during the scan: the top-of-run check said Bearer was fine.
    mocks.checkScannerPreflight.mockImplementation(async (scannerId: SecurityScannerId) =>
      scannerId === 'bearer' ? blocked('bearer', 'Start Docker Desktop.') : ready(scannerId),
    );

    const record = await runScan(['semgrep', 'bearer']);

    expect(mocks.checkScannerPreflight).toHaveBeenCalledWith('bearer', expect.anything());
    const bearer = record.runs.find((r) => r.scannerId === 'bearer');
    expect(bearer?.status).toBe('skipped');
    expect(bearer?.error).toBe('Start Docker Desktop.');
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('keeps the other findings when one scanner throws', async () => {
    mocks.run.mockImplementation(async (ctx: ScanContext) => {
      if (ctx.scannerId === 'trivy') throw new Error('trivy crashed');
      return outcome([finding(ctx.scannerId, 'semgrep-1')]);
    });

    const record = await runScan(['semgrep', 'trivy']);

    expect(record.findings.map((f) => f.id)).toEqual(['semgrep-1']);
    const trivy = record.runs.find((r) => r.scannerId === 'trivy');
    expect(trivy?.status).toBe('failed');
    expect(trivy?.error).toMatch(/trivy crashed/);
    expect(record.status).toBe('partial');
  });

  it('reports every scanner the run never reached after a cancel', async () => {
    const { cancelSecurityScan } = await import('./scanRunner');
    mocks.run.mockImplementation(async (ctx: ScanContext) => {
      // Cancelled while the first scanner was working.
      cancelSecurityScan('run-12345678');
      return { ...outcome(), cancelled: true, error: 'Cancelled.', scannerId: ctx.scannerId };
    });

    await runScan(['semgrep', 'bearer', 'codeql']);

    const lastPhase = (scannerId: SecurityScannerId) =>
      mocks.progress.filter((p) => p.scannerId === scannerId).at(-1)?.phase;
    expect(lastPhase('semgrep')).toBe('cancelled');
    expect(lastPhase('bearer')).toBe('skipped');
    expect(lastPhase('codeql')).toBe('skipped');
  });

  it('labels a scanner that ran out of time as timed out, not failed', async () => {
    mocks.run.mockImplementation(async () => ({
      ...outcome(),
      timedOut: true,
      error: 'It ran out of time.',
    }));

    await runScan(['semgrep']);

    expect(mocks.progress.filter((p) => p.scannerId === 'semgrep').at(-1)?.phase).toBe('timed-out');
  });

  it('forgets a cancel for a run that never started after a minute', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { cancelSecurityScan } = await import('./scanRunner');
    mocks.run.mockImplementation(async () => outcome());

    cancelSecurityScan('ghost-run-id');
    vi.advanceTimersByTime(61_000);
    vi.useRealTimers();

    const record = await runScan(['semgrep'], 'ghost-run-id');
    expect(record.status).toBe('complete');
  });
});
