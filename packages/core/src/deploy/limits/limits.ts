/**
 * Resource caps for one service of an app: how many cores it may use and how much of them, how
 * much memory, and how big its container's writable layer may grow. A field left out (or null) is
 * no cap. Cores and share are kept apart, though Docker only knows their product (`cpus`), so an
 * editor opened later shows what was picked rather than a number worked back from it.
 *
 * The server core writes the caps into the override file it passes to `docker compose`, so they
 * hold across redeploys, rollbacks and App Store updates. This module is the shared reading of
 * them: the checks both sides run, the Compose keys they become and the line the app shows.
 */

export interface ServiceLimits {
  service: string;
  /** Whole cores, at least one. */
  cpuCores?: number | null;
  /** How much of those cores it may use, 5 to 100. */
  cpuPercent?: number | null;
  memoryMb?: number | null;
  /** The container's writable layer, which only some storage drivers can cap. */
  diskGb?: number | null;
}

/** What the server has, so a cap above it can be refused before anything is sent. */
export interface LimitsHost {
  cores: number;
  memoryMb: number;
  /** Whether Docker on the server can cap a container's disk (storage_opt size). */
  diskLimits: boolean;
}

export const LIMIT_BOUNDS = {
  minCpuPercent: 5,
  maxCpuPercent: 100,
  /** Docker refuses a memory limit under 6 MB. */
  minMemoryMb: 6,
  minDiskGb: 1,
} as const;

/** Caps as validateLimits keeps them: only the fields that are set. */
export interface CheckedLimits {
  service: string;
  cpuCores?: number;
  cpuPercent?: number;
  memoryMb?: number;
  diskGb?: number;
}

export type LimitsValidation =
  | { ok: true; limits: CheckedLimits[] }
  | { ok: false; reason: string; service: string };

const isSet = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isWhole = (value: number) => Number.isInteger(value);

export function hasLimits(limit: ServiceLimits): boolean {
  return (
    isSet(limit.cpuCores) || isSet(limit.cpuPercent) || isSet(limit.memoryMb) || isSet(limit.diskGb)
  );
}

/** The `cpus` value Docker applies: cores times the share, to two decimals. */
export function limitCpus(limit: ServiceLimits): number | null {
  if (!isSet(limit.cpuCores) && !isSet(limit.cpuPercent)) return null;
  const cores = isSet(limit.cpuCores) ? limit.cpuCores : 1;
  const share = isSet(limit.cpuPercent) ? limit.cpuPercent : 100;
  return Math.round(cores * share) / 100;
}

/** The keys of the service's entry in the override file. */
export function limitsToCompose(limit: ServiceLimits): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const cpus = limitCpus(limit);
  const memory = isSet(limit.memoryMb) ? `${limit.memoryMb}m` : null;
  if (cpus !== null) out.cpus = cpus;
  if (memory) {
    out.mem_limit = memory;
    // The same as the memory limit, so swap cannot be used to go past it.
    out.memswap_limit = memory;
  }
  if (cpus !== null || memory) {
    // Compose refuses only different values in the two forms, so writing both overrides whichever
    // one the app's own compose file uses.
    const limits: Record<string, string> = {};
    if (cpus !== null) limits.cpus = String(cpus);
    if (memory) limits.memory = memory;
    out.deploy = { resources: { limits } };
  }
  if (isSet(limit.diskGb)) out.storage_opt = { size: `${limit.diskGb}G` };
  return out;
}

function checkOne(limit: ServiceLimits, host: LimitsHost | undefined): string | null {
  const { cpuCores, cpuPercent, memoryMb, diskGb } = limit;
  if (isSet(cpuCores)) {
    if (!isWhole(cpuCores) || cpuCores < 1)
      return 'The core count has to be a whole number, 1 or more.';
    if (host && cpuCores > host.cores) {
      return `The server has ${host.cores} ${host.cores === 1 ? 'core' : 'cores'}, so it cannot give ${cpuCores}.`;
    }
  }
  if (isSet(cpuPercent)) {
    if (
      !isWhole(cpuPercent) ||
      cpuPercent < LIMIT_BOUNDS.minCpuPercent ||
      cpuPercent > LIMIT_BOUNDS.maxCpuPercent
    ) {
      return `The CPU share has to be a whole percent from ${LIMIT_BOUNDS.minCpuPercent} to ${LIMIT_BOUNDS.maxCpuPercent}.`;
    }
  }
  if (isSet(memoryMb)) {
    if (!isWhole(memoryMb) || memoryMb < LIMIT_BOUNDS.minMemoryMb) {
      return `The memory cap has to be a whole number of MB, ${LIMIT_BOUNDS.minMemoryMb} or more.`;
    }
    if (host && memoryMb > host.memoryMb) {
      return `The server has ${formatMemoryMb(host.memoryMb)} of memory, so it cannot give ${formatMemoryMb(memoryMb)}.`;
    }
  }
  if (isSet(diskGb)) {
    if (!isWhole(diskGb) || diskGb < LIMIT_BOUNDS.minDiskGb) {
      return `The disk cap has to be a whole number of GB, ${LIMIT_BOUNDS.minDiskGb} or more.`;
    }
    if (host && !host.diskLimits) {
      return "Docker on this server can't cap a container's disk, so leave the disk unlimited.";
    }
  }
  return null;
}

/**
 * Checks caps against the app's services and, when known, the server. Services with no cap set
 * are dropped, so what is saved lists only what is capped.
 */
export function validateLimits(
  limits: readonly ServiceLimits[],
  services: readonly string[],
  host?: LimitsHost,
): LimitsValidation {
  const seen = new Set<string>();
  const kept: CheckedLimits[] = [];
  for (const limit of limits) {
    if (!services.includes(limit.service)) {
      return {
        ok: false,
        service: limit.service,
        reason: `There is no service called ${limit.service} in this app.`,
      };
    }
    if (seen.has(limit.service)) {
      return {
        ok: false,
        service: limit.service,
        reason: `${limit.service} has caps listed twice.`,
      };
    }
    seen.add(limit.service);
    const problem = checkOne(limit, host);
    if (problem) return { ok: false, service: limit.service, reason: problem };
    if (!hasLimits(limit)) continue;
    const clean: CheckedLimits = { service: limit.service };
    if (isSet(limit.cpuCores)) clean.cpuCores = limit.cpuCores;
    if (isSet(limit.cpuPercent)) clean.cpuPercent = limit.cpuPercent;
    if (isSet(limit.memoryMb)) clean.memoryMb = limit.memoryMb;
    if (isSet(limit.diskGb)) clean.diskGb = limit.diskGb;
    kept.push(clean);
  }
  return { ok: true, limits: kept };
}

/** 2048 as "2 GB", 768 as "768 MB". */
export function formatMemoryMb(mb: number): string {
  return mb >= 1024 && mb % 1024 === 0
    ? `${mb / 1024} GB`
    : mb >= 1024
      ? `${(mb / 1024).toFixed(1)} GB`
      : `${mb} MB`;
}

/** The caps as one short line, such as "2 cores at 50% · 2 GB RAM · 20 GB disk". */
export function describeLimits(limit: ServiceLimits): string {
  const parts: string[] = [];
  if (isSet(limit.cpuCores) || isSet(limit.cpuPercent)) {
    const cores = isSet(limit.cpuCores) ? limit.cpuCores : 1;
    const share = isSet(limit.cpuPercent) ? limit.cpuPercent : 100;
    const count = `${cores} ${cores === 1 ? 'core' : 'cores'}`;
    parts.push(share === 100 ? count : `${count} at ${share}%`);
  }
  if (isSet(limit.memoryMb)) parts.push(`${formatMemoryMb(limit.memoryMb)} RAM`);
  if (isSet(limit.diskGb)) parts.push(`${limit.diskGb} GB disk`);
  return parts.length > 0 ? parts.join(' · ') : 'No limits';
}
