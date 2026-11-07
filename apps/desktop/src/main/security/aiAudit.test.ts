import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../test/main/ipcHarness';

/**
 * The AI audit's file side: where the skill is installed, and the run folders the agent writes
 * under ~/security-audit-skill/<project>/run-<N>. Everything is keyed by project id, and a run
 * name from the renderer is checked before it touches a path.
 */

const node = vi.hoisted(() => ({ result: { ok: true, stdout: 'v22.20.0' } }));
vi.mock('./exec', () => ({ probe: async () => node.result }));

const userData = useTempUserData();

let projectDir = '';
let home = '';
let runsRoot = '';

function write(path: string, content: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
}

const confirmed = {
  verdict: 'confirmed',
  fingerprint: 'sqli:a.ts:1',
  title: 'SQL injection',
  description: '',
  root_cause: '',
  intended_behavior: '',
  trace: [{ kind: 'sink', file: 'a.ts', line: 1, scope: '', description: '' }],
  evidence: [],
  conditions: [],
  execution: {
    attacker_perspective: '',
    payloads: ['x'],
    instructions: ['y'],
    observed_result: '',
  },
  remediation: { strategy: 'Parameterize.' },
  severity: {
    likelihood: { score: 'high', reason: '' },
    impact: { score: 'high', reason: '' },
    overall_severity: 'high',
  },
  confidence: { score: 'high', reason: '' },
};

beforeEach(() => {
  node.result = { ok: true, stdout: 'v22.20.0' };
  home = join(userData.dir, 'home');
  projectDir = join(userData.dir, 'work', 'shop');
  runsRoot = join(home, 'security-audit-skill', 'shop');
  mkdirSync(projectDir, { recursive: true });
  userData.writeData('projects.json', [
    {
      id: 'p1',
      name: 'Shop',
      folderPath: projectDir,
      agentType: 'claude-code',
      createdAt: '2026-11-01T00:00:00Z',
    },
  ]);
});

async function load() {
  return import('./aiAudit');
}

describe('getAuditStatus', () => {
  it('is not installed in a project without the skill', async () => {
    const { getAuditStatus } = await load();
    const status = await getAuditStatus('p1');

    expect(status.installed).toBe(false);
    expect(status.locations).toEqual([]);
    expect(status.runsRoot).toBe(runsRoot);
  });

  it('finds the skill in any agent folder of the project', async () => {
    write(join(projectDir, '.claude', 'skills', 'security-audit', 'SKILL.md'), '# skill');
    write(join(projectDir, '.agents', 'skills', 'security-audit', 'SKILL.md'), '# skill');
    const { getAuditStatus } = await load();

    const status = await getAuditStatus('p1');

    expect(status.installed).toBe(true);
    expect(status.locations).toEqual([
      { path: '.claude/skills/security-audit', scope: 'project' },
      { path: '.agents/skills/security-audit', scope: 'project' },
    ]);
  });

  it('reports a global copy without counting it as installed in the project', async () => {
    write(join(home, '.claude', 'skills', 'security-audit', 'SKILL.md'), '# skill');
    const { getAuditStatus } = await load();

    const status = await getAuditStatus('p1');

    expect(status.installed).toBe(false);
    expect(status.locations).toEqual([
      { path: '~/.claude/skills/security-audit', scope: 'global' },
    ]);
  });

  it('checks the Node version the installer needs', async () => {
    const { getAuditStatus } = await load();
    expect((await getAuditStatus('p1')).node).toEqual({
      found: true,
      version: 'v22.20.0',
      meetsMinimum: true,
    });

    node.result = { ok: true, stdout: 'v20.11.1' };
    expect((await getAuditStatus('p1')).node.meetsMinimum).toBe(false);

    node.result = { ok: false, stdout: '' };
    expect((await getAuditStatus('p1')).node).toEqual({
      found: false,
      version: null,
      meetsMinimum: false,
    });
  });

  it('refuses a project it does not know', async () => {
    const { getAuditStatus } = await load();
    await expect(getAuditStatus('nope')).rejects.toThrow(/not found/);
  });
});

describe('listAuditRuns', () => {
  it('lists run folders newest first and ignores anything else', async () => {
    write(join(runsRoot, 'run-1', 'run-metadata.json'), { run_status: 'complete' });
    write(join(runsRoot, 'run-1', 'findings.json'), [confirmed]);
    write(join(runsRoot, 'run-1', 'REPORT.md'), '# Report');
    write(join(runsRoot, 'run-2', 'run-metadata.json'), { run_status: 'in_progress' });
    write(join(runsRoot, 'notes', 'x.txt'), 'x');
    const { listAuditRuns } = await load();

    const runs = await listAuditRuns('p1');

    expect(runs.map((run) => run.runName)).toEqual(['run-2', 'run-1']);
    expect(runs[0].phase).toBe('reconnaissance');
    expect(runs[1]).toMatchObject({
      phase: 'complete',
      hasReport: true,
      counts: { confirmed: 1, bySeverity: expect.objectContaining({ high: 1 }) },
      outputDir: join(runsRoot, 'run-1'),
    });
  });

  it('is empty before the first run', async () => {
    const { listAuditRuns } = await load();
    expect(await listAuditRuns('p1')).toEqual([]);
  });

  it('dates the last activity from the newest file in the run', async () => {
    write(join(runsRoot, 'run-1', 'run-metadata.json'), { run_status: 'in_progress' });
    write(join(runsRoot, 'run-1', 'coverage-ledger.json'), [{ status: 'planned' }]);
    const old = new Date('2026-11-01T10:00:00Z');
    const recent = new Date('2026-11-01T11:30:00Z');
    utimesSync(join(runsRoot, 'run-1', 'run-metadata.json'), old, old);
    utimesSync(join(runsRoot, 'run-1', 'coverage-ledger.json'), recent, recent);
    utimesSync(join(runsRoot, 'run-1'), old, old);
    const { listAuditRuns } = await load();

    const [run] = await listAuditRuns('p1');

    expect(run.lastActivityAt).toBe(recent.toISOString());
    expect(run.ledger).toEqual({ total: 1, settled: 0, byStatus: { planned: 1 } });
  });
});

describe('getAuditRun', () => {
  it('reads the findings and the report of one run', async () => {
    write(join(runsRoot, 'run-1', 'run-metadata.json'), { run_status: 'complete' });
    write(join(runsRoot, 'run-1', 'findings.json'), [confirmed, { verdict: 'broken' }]);
    write(join(runsRoot, 'run-1', 'REPORT.md'), '# Report\nAll good.');
    const { getAuditRun } = await load();

    const run = await getAuditRun('p1', 'run-1');

    expect(run.findings.map((f) => f.fingerprint)).toEqual(['sqli:a.ts:1']);
    expect(run.droppedFindings).toBe(1);
    expect(run.report).toBe('# Report\nAll good.');
  });

  it('treats a half-written findings file as no findings yet', async () => {
    write(join(runsRoot, 'run-1', 'findings.json'), '[{"verdict": "confirmed", "finge');
    const { getAuditRun } = await load();

    const run = await getAuditRun('p1', 'run-1');

    expect(run.findings).toEqual([]);
    expect(run.phase).toBe('verification');
  });

  it('refuses a run name that is not run-<N>', async () => {
    const { getAuditRun } = await load();
    await expect(getAuditRun('p1', '../../etc')).rejects.toThrow(/run name/i);
  });

  it('says so when the run is gone', async () => {
    const { getAuditRun } = await load();
    await expect(getAuditRun('p1', 'run-9')).rejects.toThrow(/no longer there/i);
  });
});

describe('prepareAuditRun', () => {
  it('creates the next run folder and hands back where it is', async () => {
    write(join(runsRoot, 'run-3', 'run-metadata.json'), {});
    const { prepareAuditRun, listAuditRuns } = await load();

    const prepared = await prepareAuditRun('p1');

    expect(prepared).toEqual({ runName: 'run-4', outputDir: join(runsRoot, 'run-4') });
    const runs = await listAuditRuns('p1');
    expect(runs[0]).toMatchObject({ runName: 'run-4', phase: 'starting' });
  });
});

describe('auditRunPath', () => {
  it('resolves the folder and the report of a run', async () => {
    write(join(runsRoot, 'run-1', 'REPORT.md'), '#');
    const { auditRunPath } = await load();

    expect(await auditRunPath('p1', 'run-1', 'folder')).toBe(join(runsRoot, 'run-1'));
    expect(await auditRunPath('p1', 'run-1', 'report')).toBe(join(runsRoot, 'run-1', 'REPORT.md'));
    await expect(auditRunPath('p1', 'run-x', 'folder')).rejects.toThrow(/run name/i);
  });
});
