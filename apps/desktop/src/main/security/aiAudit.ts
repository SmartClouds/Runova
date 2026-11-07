import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  AiAuditFinding,
  AiAuditLedgerSummary,
  AiAuditRunDetail,
  AiAuditRunMetadata,
  AiAuditRunSummary,
  AiAuditStatus,
} from '@runova/core';
import {
  auditRunNumber,
  countAuditFindings,
  inferAuditPhase,
  isAuditRunName,
  KNOWN_AGENT_DIRS,
  nextAuditRunName,
  nodeMeetsAuditMinimum,
  parseAuditFindings,
  parseRunMetadata,
  SECURITY_AUDIT_RUNS_FOLDER,
  SECURITY_AUDIT_SKILL_NAME,
  summarizeLedger,
} from '@runova/core';
import { app } from 'electron';
import { store } from '../store';
import { probe } from './exec';

/**
 * The file side of the AI security audit (Cloudflare's security-audit skill). The agent does the
 * work in a terminal; this module only looks at what it leaves on disk: the skill's folder in the
 * project, and the run folders under ~/security-audit-skill/<project folder>/run-<N>.
 *
 * Every entry point takes a project id and resolves paths here. A run name from the renderer is
 * held to `run-<N>` before it is joined onto anything, so a compromised page cannot read or open
 * files elsewhere.
 */

/** findings.json past this is not something a person reads in a list anyway. */
const MAX_FINDINGS_BYTES = 25 * 1024 * 1024;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

async function getProject(projectId: string): Promise<{ folderPath: string; name: string }> {
  const project = (await store.getProjects()).find((p) => p.id === projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  return { folderPath: project.folderPath, name: project.name };
}

async function isFile(path: string): Promise<boolean> {
  return stat(path)
    .then((stats) => stats.isFile())
    .catch(() => false);
}

function runsRootFor(project: { folderPath: string; name: string }): string {
  // The folder's own name, like the skill's default `<repo>`; the display name covers a path that
  // has none (a drive root).
  const folder = basename(project.folderPath) || project.name.replace(/[\\/:*?"<>|]/g, '-');
  return join(app.getPath('home'), SECURITY_AUDIT_RUNS_FOLDER, folder);
}

function checkRunName(runName: string): void {
  if (!isAuditRunName(runName)) throw new Error(`Not a run name: ${runName}`);
}

async function readJson(path: string, maxBytes: number): Promise<unknown> {
  try {
    const stats = await stat(path);
    if (stats.size > maxBytes) return null;
    return JSON.parse(await readFile(path, 'utf-8')) as unknown;
  } catch {
    // Missing, or the agent is halfway through writing it. Either way there is nothing to show.
    return null;
  }
}

async function readText(path: string, maxBytes: number): Promise<string | null> {
  try {
    const stats = await stat(path);
    const text = await readFile(path, 'utf-8');
    return stats.size > maxBytes ? `${text.slice(0, maxBytes)}\n\n(cut off here)` : text;
  } catch {
    return null;
  }
}

export async function getAuditStatus(projectId: string): Promise<AiAuditStatus> {
  const project = await getProject(projectId);
  const home = app.getPath('home');
  const locations: AiAuditStatus['locations'] = [];

  for (const agentDir of KNOWN_AGENT_DIRS) {
    const skillDir = join(agentDir, 'skills', SECURITY_AUDIT_SKILL_NAME);
    if (await isFile(join(project.folderPath, skillDir, 'SKILL.md'))) {
      locations.push({ path: `${agentDir}/skills/${SECURITY_AUDIT_SKILL_NAME}`, scope: 'project' });
    }
  }
  for (const agentDir of KNOWN_AGENT_DIRS) {
    if (await isFile(join(home, agentDir, 'skills', SECURITY_AUDIT_SKILL_NAME, 'SKILL.md'))) {
      locations.push({
        path: `~/${agentDir}/skills/${SECURITY_AUDIT_SKILL_NAME}`,
        scope: 'global',
      });
    }
  }

  const nodeProbe = await probe('node', ['--version']);
  const version = nodeProbe.ok ? nodeProbe.stdout.trim() || null : null;

  return {
    installed: locations.some((location) => location.scope === 'project'),
    locations,
    node: { found: nodeProbe.ok, version, meetsMinimum: nodeMeetsAuditMinimum(version) },
    runsRoot: runsRootFor(project),
  };
}

interface RunFiles {
  files: string[];
  metadata: AiAuditRunMetadata | null;
  ledger: AiAuditLedgerSummary | null;
  findings: AiAuditFinding[];
  droppedFindings: number;
  findingsWritten: boolean;
  startedAt: string;
  lastActivityAt: string;
}

async function readRunFiles(dir: string): Promise<RunFiles> {
  const dirStats = await stat(dir);
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);

  // The newest top-level file says whether the agent is still at it. Subfolders hold scratch
  // work the agents churn through, so the folder's own time covers those well enough.
  let lastActivity = dirStats.mtimeMs;
  for (const name of files) {
    const fileStats = await stat(join(dir, name)).catch(() => null);
    if (fileStats && fileStats.mtimeMs > lastActivity) lastActivity = fileStats.mtimeMs;
  }

  const findingsWritten = files.includes('findings.json');
  const { findings, dropped } = findingsWritten
    ? parseAuditFindings(await readJson(join(dir, 'findings.json'), MAX_FINDINGS_BYTES))
    : { findings: [], dropped: 0 };

  return {
    files,
    metadata: parseRunMetadata(await readJson(join(dir, 'run-metadata.json'), MAX_REPORT_BYTES)),
    ledger: summarizeLedger(await readJson(join(dir, 'coverage-ledger.json'), MAX_FINDINGS_BYTES)),
    findings,
    droppedFindings: dropped,
    findingsWritten,
    startedAt: new Date(dirStats.birthtimeMs || dirStats.ctimeMs).toISOString(),
    lastActivityAt: new Date(lastActivity).toISOString(),
  };
}

function summarize(runName: string, outputDir: string, run: RunFiles): AiAuditRunSummary {
  return {
    runName,
    outputDir,
    phase: inferAuditPhase({ files: run.files, metadata: run.metadata, ledger: run.ledger }),
    metadata: run.metadata,
    counts: run.findingsWritten ? countAuditFindings(run.findings) : null,
    ledger: run.ledger,
    startedAt: run.startedAt,
    lastActivityAt: run.lastActivityAt,
    hasReport: run.files.includes('REPORT.md'),
  };
}

/** Every run-<N> folder of the project, newest first. */
export async function listAuditRuns(projectId: string): Promise<AiAuditRunSummary[]> {
  const root = runsRootFor(await getProject(projectId));
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((entry) => entry.isDirectory() && isAuditRunName(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (auditRunNumber(b) ?? 0) - (auditRunNumber(a) ?? 0));

  const runs: AiAuditRunSummary[] = [];
  for (const name of names) {
    const dir = join(root, name);
    const files = await readRunFiles(dir).catch(() => null);
    if (files) runs.push(summarize(name, dir, files));
  }
  return runs;
}

export async function getAuditRun(projectId: string, runName: string): Promise<AiAuditRunDetail> {
  checkRunName(runName);
  const dir = join(runsRootFor(await getProject(projectId)), runName);
  const files = await readRunFiles(dir).catch(() => {
    throw new Error(`${runName} is no longer there. It may have been moved or deleted.`);
  });
  return {
    ...summarize(runName, dir, files),
    findings: files.findings,
    droppedFindings: files.droppedFindings,
    report: files.files.includes('REPORT.md')
      ? await readText(join(dir, 'REPORT.md'), MAX_REPORT_BYTES)
      : null,
  };
}

/**
 * Makes the folder the next run writes into. Creating it up front lets the tracker show the run
 * (as "starting") the moment the agent is launched, before it has written anything.
 */
export async function prepareAuditRun(
  projectId: string,
): Promise<{ runName: string; outputDir: string }> {
  const root = runsRootFor(await getProject(projectId));
  const existing = await readdir(root).catch(() => [] as string[]);
  const runName = nextAuditRunName(existing);
  const outputDir = join(root, runName);
  await mkdir(outputDir, { recursive: true });
  return { runName, outputDir };
}

export async function auditRunPath(
  projectId: string,
  runName: string,
  target: 'folder' | 'report',
): Promise<string> {
  checkRunName(runName);
  const dir = join(runsRootFor(await getProject(projectId)), runName);
  return target === 'report' ? join(dir, 'REPORT.md') : dir;
}
