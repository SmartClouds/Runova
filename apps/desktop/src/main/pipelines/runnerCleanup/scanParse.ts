import type {
  RunnerCleanupDisk,
  RunnerCleanupItemOutcome,
  RunnerCleanupJobKind,
  RunnerCleanupOs,
} from '../../../shared/apiTypes';
import { type CacheId, isCacheId } from './cacheCatalog';

/**
 * Reads what the runner cleanup scripts print (E104). The POSIX and the PowerShell scan print the
 * same tab-separated lines, one fact per line and the kind of fact first, so one parser serves
 * Linux, macOS and Windows. Lines it does not know are skipped, since a tool on the machine can
 * always print something of its own.
 */

export type SizeKind =
  | 'checkout'
  | 'temp'
  | 'actions'
  | 'update'
  | 'tool'
  | 'oldver'
  | 'diag'
  /** The whole runner folder. */
  | 'total';

const SIZE_KINDS = new Set<string>([
  'checkout',
  'temp',
  'actions',
  'update',
  'tool',
  'oldver',
  'diag',
  'total',
]);

export type ScanStep = 'runners' | 'docker' | 'caches' | 'schedule';
const STEPS = new Set<string>(['runners', 'docker', 'caches', 'schedule']);

export interface RunnerRegistration {
  agentId: number | null;
  name: string;
  /** `https://github.com/owner/repo` or `https://github.com/org`. */
  url: string;
}

export interface RunnerFolderFacts {
  dir: string;
  registration: RunnerRegistration | null;
  /** A `.runner` file is there, even when it could not be read. */
  hasRunnerFile: boolean;
  /** The folder has `config.sh` or `config.cmd`, so it is a runner install. */
  configured: boolean;
  /** The service name the runner wrote to `.service`, when it runs as one. */
  service: string | null;
  busy: boolean;
  sizes: { kind: SizeKind; bytes: number; path: string }[];
}

export interface DockerRow {
  type: string;
  reclaimableBytes: number;
  totalCount: number;
  active: number;
}

export interface DockerFacts {
  state: 'ok' | 'missing' | 'denied';
  viaSudo: boolean;
  rows: DockerRow[];
  danglingBytes: number;
}

export interface CacheFacts {
  id: CacheId;
  home: string;
  bytes: number;
  path: string;
}

export interface ScheduleFacts {
  installed: boolean;
  job: RunnerCleanupJobKind | null;
  config: string | null;
  lastLog: string | null;
  noCron: boolean;
}

export interface MachineFacts {
  os: RunnerCleanupOs | null;
  home: string;
  runners: RunnerFolderFacts[];
  /** A job is running but Windows would not say from which folder (another account's process). */
  busyUnknown: boolean;
  docker: DockerFacts;
  caches: CacheFacts[];
  tools: Set<string>;
  disk: RunnerCleanupDisk | null;
  schedule: ScheduleFacts;
}

const OS_NAMES: Record<string, RunnerCleanupOs> = {
  Linux: 'linux',
  Darwin: 'macos',
  Windows: 'windows',
};

const JOBS = new Set<string>(['cron', 'launchd', 'task']);

function kbToBytes(text: string | undefined): number | null {
  const kb = Number(text);
  return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : null;
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  pb: 1e15,
};

/** Docker's sizes (`1.2GB`, `512.5MB`, `0B`), which count in thousands. */
export function parseHumanSize(text: string): number | null {
  const match = /^\s*([\d.]+)\s*([kKMGTP]?B)\b/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = UNITS[match[2].toLowerCase()];
  if (!Number.isFinite(value) || unit === undefined) return null;
  return Math.round(value * unit);
}

/** Where a runner is registered, from the URL in its `.runner` file. Null when Runova cannot ask. */
export function parseGithubUrl(url: string): { kind: 'repo' | 'org'; name: string } | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+))?\/?$/.exec(
    url.trim(),
  );
  if (!match) return null;
  if (match[1].toLowerCase() === 'enterprises') return null;
  return match[2]
    ? { kind: 'repo', name: `${match[1]}/${match[2]}` }
    : { kind: 'org', name: match[1] };
}

function parseRegistration(encoded: string | undefined): RunnerRegistration | null {
  if (!encoded) return null;
  try {
    const text = Buffer.from(encoded, 'base64').toString('utf8').replace(/^﻿/, '');
    const data = JSON.parse(text) as {
      agentId?: unknown;
      agentName?: unknown;
      gitHubUrl?: unknown;
    };
    if (typeof data.agentName !== 'string' || typeof data.gitHubUrl !== 'string') return null;
    return {
      agentId: typeof data.agentId === 'number' ? data.agentId : null,
      name: data.agentName,
      url: data.gitHubUrl,
    };
  } catch {
    return null;
  }
}

/** The data line of `df -Pk`, read with a pattern since a mount can contain spaces. */
function parseDfLine(text: string): RunnerCleanupDisk | null {
  const match = /^(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\/.*)$/.exec(text.trim());
  if (!match) return null;
  const used = Number(match[3]) * 1024;
  const available = Number(match[4]) * 1024;
  return { usedBytes: used, totalBytes: used + available, mount: match[6] };
}

function parseDockerRow(json: string): DockerRow | null {
  try {
    const data = JSON.parse(json) as Record<string, unknown>;
    if (typeof data.Type !== 'string') return null;
    return {
      type: data.Type,
      reclaimableBytes: parseHumanSize(String(data.Reclaimable ?? '')) ?? 0,
      totalCount: Number(data.TotalCount) || 0,
      active: Number(data.Active) || 0,
    };
  } catch {
    return null;
  }
}

export function scanStepOf(text: string): ScanStep | null {
  const [kind, step] = text.trim().split('\t');
  return kind === 'step' && step && STEPS.has(step) ? (step as ScanStep) : null;
}

export function parseScanOutput(stdout: string): MachineFacts {
  const facts: MachineFacts = {
    os: null,
    home: '',
    runners: [],
    busyUnknown: false,
    docker: { state: 'missing', viaSudo: false, rows: [], danglingBytes: 0 },
    caches: [],
    tools: new Set(),
    disk: null,
    schedule: { installed: false, job: null, config: null, lastLog: null, noCron: false },
  };
  const runners = new Map<string, RunnerFolderFacts>();
  const runnerAt = (dir: string | undefined): RunnerFolderFacts | null =>
    dir ? (runners.get(dir) ?? null) : null;

  for (const raw of stdout.split(/\r?\n/)) {
    const text = raw.replace(/\s+$/, '');
    if (!text) continue;
    const [kind, ...rest] = text.split('\t');
    switch (kind) {
      case 'os':
        facts.os = OS_NAMES[rest[0] ?? ''] ?? null;
        break;
      case 'home':
        facts.home = rest[0] ?? '';
        break;
      case 'runner': {
        const dir = rest[0];
        if (dir && !runners.has(dir)) {
          runners.set(dir, {
            dir,
            registration: null,
            hasRunnerFile: false,
            configured: false,
            service: null,
            busy: false,
            sizes: [],
          });
        }
        break;
      }
      case 'runnerjson': {
        const runner = runnerAt(rest[0]);
        if (runner) runner.registration = parseRegistration(rest[1]);
        break;
      }
      case 'runnerfile': {
        const runner = runnerAt(rest[0]);
        if (runner) runner.hasRunnerFile = true;
        break;
      }
      case 'configured': {
        const runner = runnerAt(rest[0]);
        if (runner) runner.configured = true;
        break;
      }
      case 'service': {
        const runner = runnerAt(rest[0]);
        if (runner && rest[1]) runner.service = rest[1].trim();
        break;
      }
      case 'busy': {
        const runner = runnerAt(rest[0]);
        if (runner) runner.busy = true;
        break;
      }
      case 'busyunknown':
        facts.busyUnknown = true;
        break;
      case 'size': {
        const [dir, sizeKind, kb, path] = rest;
        const runner = runnerAt(dir);
        const bytes = kbToBytes(kb);
        if (runner && SIZE_KINDS.has(sizeKind) && bytes !== null && path) {
          runner.sizes.push({ kind: sizeKind as SizeKind, bytes, path });
        }
        break;
      }
      case 'docker':
        if (rest[0] === 'ok' || rest[0] === 'denied' || rest[0] === 'missing') {
          facts.docker.state = rest[0];
        }
        facts.docker.viaSudo = rest[1] === 'sudo';
        break;
      case 'dockerdf': {
        const row = parseDockerRow(rest.join('\t'));
        if (row) facts.docker.rows.push(row);
        break;
      }
      case 'dockerdangling':
        facts.docker.danglingBytes += parseHumanSize(rest[0] ?? '') ?? 0;
        break;
      case 'cache': {
        const [id, home, kb, path] = rest;
        const bytes = kbToBytes(kb);
        if (id && isCacheId(id) && home && bytes !== null && path) {
          facts.caches.push({ id, home, bytes, path });
        }
        break;
      }
      case 'tool':
        if (rest[0]) facts.tools.add(rest[0]);
        break;
      case 'disk':
        facts.disk = parseDfLine(rest.join('\t')) ?? facts.disk;
        break;
      case 'diskwin': {
        const [mount, size, free] = rest;
        const total = Number(size);
        const available = Number(free);
        if (mount && Number.isFinite(total) && Number.isFinite(available) && total > 0) {
          facts.disk = { usedBytes: Math.max(0, total - available), totalBytes: total, mount };
        }
        break;
      }
      case 'sched':
        if (rest[0] === 'installed' && JOBS.has(rest[1] ?? '')) {
          facts.schedule.installed = true;
          facts.schedule.job = rest[1] as RunnerCleanupJobKind;
        }
        break;
      case 'schedconfig':
        facts.schedule.config = rest.join('\t') || null;
        break;
      case 'schedlog':
        facts.schedule.lastLog = rest.join('\t') || null;
        break;
      case 'nocron':
        facts.schedule.noCron = true;
        break;
      default:
        break;
    }
  }
  facts.runners = [...runners.values()];
  return facts;
}

/** One item's answer from a cleanup script, or null for any other line. */
export function parseCleanLine(text: string): RunnerCleanupItemOutcome | null {
  const [marker, id, ...rest] = text.replace(/\s+$/, '').split('\t');
  if (!id) return null;
  const kb = (value: string | undefined) => Math.max(0, kbToBytes(value) ?? 0);
  switch (marker) {
    case '@@done':
      return { id, status: 'done', freedBytes: kb(rest[0]) };
    case '@@donehuman':
      return { id, status: 'done', freedBytes: parseHumanSize(rest[0] ?? '') ?? 0 };
    case '@@fail':
      return {
        id,
        status: 'failed',
        freedBytes: kb(rest[0]),
        error: rest.slice(1).join(' ').trim() || 'It could not be removed.',
      };
    case '@@skip':
      return { id, status: 'skipped', freedBytes: 0, error: rest.join(' ').trim() };
    default:
      return null;
  }
}

/** What a job install or removal answered. */
export function parseScheduleLine(
  text: string,
): { ok: true; note: string | null } | { ok: false; error: string } | null {
  const [marker, ...rest] = text.replace(/\s+$/, '').split('\t');
  if (marker === '@@ok') return { ok: true, note: rest[0] || null };
  if (marker === '@@error') return { ok: false, error: rest.join(' ') || 'unknown error' };
  return null;
}
