import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  AiAuditFinding,
  AiAuditLedgerSummary,
  AiAuditRunDetail,
  AiAuditRunMetadata,
  AiAuditRunSummary,
  AiAuditStatus,
  AiAuditTriage,
} from '@runova/core';
import {
  AI_AUDIT_TRIAGE_FILE,
  applyAuditTriage,
  auditRunNumber,
  countAuditFindings,
  inferAuditPhase,
  isAuditRunName,
  KNOWN_AGENT_DIRS,
  nextAuditRunName,
  nodeMeetsAuditMinimum,
  parseAuditFindings,
  parseAuditTriage,
  parseRunMetadata,
  SECURITY_AUDIT_RUNS_FOLDER,
  SECURITY_AUDIT_SKILL_NAME,
  serializeAuditTriage,
  summarizeLedger,
} from '@runova/core';
import { app } from 'electron';
import { store } from '../store';
import { probe } from './exec';

/**
 * The file side of the AI security audit (Cloudflare's security-audit skill). The agent does the
 * work in a terminal; this module only looks at what it leaves on disk: the skill's folder in the
 * project, and the run folders under ~/security-audit-skill/<project folder>/run-<N> (or under the
 * folder the user picked for the project instead).
 *
 * Every entry point takes a project id and resolves paths here. A run name from the renderer is
 * held to `run-<N>` before it is joined onto anything, so a compromised page cannot read or open
 * files elsewhere.
 */

/** findings.json past this is not something a person reads in a list anyway. */
const MAX_FINDINGS_BYTES = 25 * 1024 * 1024;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_TRIAGE_BYTES = 2 * 1024 * 1024;

interface AuditProject {
  id: string;
  folderPath: string;
  name: string;
}

async function getProject(projectId: string): Promise<AuditProject> {
  const project = (await store.getProjects()).find((p) => p.id === projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  return { id: project.id, folderPath: project.folderPath, name: project.name };
}

async function isFile(path: string): Promise<boolean> {
  return stat(path)
    .then((stats) => stats.isFile())
    .catch(() => false);
}

function defaultRunsRoot(project: AuditProject): string {
  // The folder's own name, like the skill's default `<repo>`; the display name covers a path that
  // has none (a drive root).
  const folder = basename(project.folderPath) || project.name.replace(/[\\/:*?"<>|]/g, '-');
  return join(app.getPath('home'), SECURITY_AUDIT_RUNS_FOLDER, folder);
}

/** The same folder, or one inside it. `relative` already ignores case where the OS does. */
function isInside(folder: string, parent: string): boolean {
  const path = relative(parent, folder);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function runsRootFor(project: AuditProject): Promise<{ root: string; isDefault: boolean }> {
  const saved = (await store.getSettings()).aiAuditRunsRoots?.[project.id];
  return typeof saved === 'string' && isAbsolute(saved)
    ? { root: saved, isDefault: false }
    : { root: defaultRunsRoot(project), isDefault: true };
}

async function runsRootOf(projectId: string): Promise<string> {
  return (await runsRootFor(await getProject(projectId))).root;
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

  const runs = await runsRootFor(project);
  return {
    installed: locations.some((location) => location.scope === 'project'),
    locations,
    node: { found: nodeProbe.ok, version, meetsMinimum: nodeMeetsAuditMinimum(version) },
    runsRoot: runs.root,
    runsRootIsDefault: runs.isDefault,
    runsRootInsideProject: isInside(runs.root, project.folderPath),
  };
}

/**
 * Saves the folder this project's runs go to, or with `null` goes back to the default. Picking
 * the default folder itself counts as going back to it. Runs already in the old folder stay
 * there; the tracker lists the new folder's runs from now on.
 */
export async function setAuditRunsRoot(projectId: string, folder: unknown): Promise<AiAuditStatus> {
  if (folder !== null && (typeof folder !== 'string' || !isAbsolute(folder))) {
    throw new Error('The results folder needs a full path.');
  }
  const project = await getProject(projectId);
  const chosen = folder === null ? null : resolve(folder);
  await store.updateSettings((settings) => {
    const roots = { ...(settings.aiAuditRunsRoots ?? {}) };
    if (chosen === null || relative(defaultRunsRoot(project), chosen) === '') {
      delete roots[projectId];
    } else {
      roots[projectId] = chosen;
    }
    return { ...settings, aiAuditRunsRoots: roots };
  });
  return getAuditStatus(projectId);
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
    // Triage is written after the run, by Runova or a fixing agent; it is not the audit working.
    if (name === AI_AUDIT_TRIAGE_FILE) continue;
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
  const root = await runsRootOf(projectId);
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
  const dir = join(await runsRootOf(projectId), runName);
  const files = await readRunFiles(dir).catch(() => {
    throw new Error(`${runName} is no longer there. It may have been moved or deleted.`);
  });
  return {
    ...summarize(runName, dir, files),
    findings: files.findings,
    droppedFindings: files.droppedFindings,
    triage: files.files.includes(AI_AUDIT_TRIAGE_FILE)
      ? parseAuditTriage(await readJson(join(dir, AI_AUDIT_TRIAGE_FILE), MAX_TRIAGE_BYTES))
      : {},
    report: files.files.includes('REPORT.md')
      ? await readText(join(dir, 'REPORT.md'), MAX_REPORT_BYTES)
      : null,
  };
}

/**
 * Records what the user decided about one finding (or clears it with `null`) in the run's
 * runova-triage.json, keeping every other entry, including ones an agent wrote. The write goes
 * through a temporary file so a reader never sees half of it.
 */
export async function setAuditTriage(
  projectId: string,
  runName: string,
  fingerprint: unknown,
  change: unknown,
): Promise<AiAuditTriage> {
  checkRunName(runName);
  if (change !== null && (typeof change !== 'object' || Array.isArray(change))) {
    throw new Error('Not a triage change.');
  }
  const dir = join(await runsRootOf(projectId), runName);
  const dirStats = await stat(dir).catch(() => null);
  if (!dirStats?.isDirectory()) {
    throw new Error(`${runName} is no longer there. It may have been moved or deleted.`);
  }
  const path = join(dir, AI_AUDIT_TRIAGE_FILE);
  const current = parseAuditTriage(await readJson(path, MAX_TRIAGE_BYTES));
  const next = applyAuditTriage(
    current,
    fingerprint,
    change as { status: unknown; note?: unknown } | null,
    new Date().toISOString(),
  );
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, serializeAuditTriage(next), 'utf-8');
  await rename(temporary, path);
  return next;
}

/**
 * Makes the folder the next run writes into. Creating it up front lets the tracker show the run
 * (as "starting") the moment the agent is launched, before it has written anything.
 */
export async function prepareAuditRun(
  projectId: string,
): Promise<{ runName: string; outputDir: string }> {
  const root = await runsRootOf(projectId);
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
  const dir = join(await runsRootOf(projectId), runName);
  return target === 'report' ? join(dir, 'REPORT.md') : dir;
}
