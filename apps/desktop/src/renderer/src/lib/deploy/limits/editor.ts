import { formatMemoryMb, hasLimits, limitCpus, type ServiceLimits } from '@runova/core';

/**
 * The draft behind the resource limits editor: one entry per service that has a cap, in the
 * order of the services, with the defaults a cap starts from when it is switched on.
 */

export interface LimitsHostFacts {
  cores: number;
  memoryMb: number;
  /** Whether Docker on the server can cap a container's disk. */
  diskLimits: boolean;
  /** Why it cannot, when it cannot. */
  diskNote?: string | null;
}

const MEMORY_PRESETS_MB = [512, 1024, 2048, 4096, 8192] as const;

export const DISK_DEFAULT_GB = 20;

const FIELDS = ['cpuCores', 'cpuPercent', 'memoryMb', 'diskGb'] as const;

/** The entry with only the caps that are set. */
function clean(limit: ServiceLimits): ServiceLimits {
  const out: ServiceLimits = { service: limit.service };
  for (const field of FIELDS) {
    const value = limit[field];
    if (typeof value === 'number' && Number.isFinite(value)) out[field] = value;
  }
  return out;
}

export function limitFor(value: readonly ServiceLimits[], service: string): ServiceLimits {
  const found = value.find((limit) => limit.service === service);
  return found ? clean(found) : { service };
}

/** The draft with one service's caps replaced; a service with none left drops out. */
export function setLimit(
  value: readonly ServiceLimits[],
  services: readonly string[],
  next: ServiceLimits,
): ServiceLimits[] {
  return services.flatMap((service) => {
    const limit = service === next.service ? clean(next) : limitFor(value, service);
    return hasLimits(limit) ? [limit] : [];
  });
}

/** Every service on the caps of one. */
export function copyToAll(
  value: readonly ServiceLimits[],
  services: readonly string[],
  from: string,
): ServiceLimits[] {
  const source = limitFor(value, from);
  if (!hasLimits(source)) return [];
  return services.map((service) => ({ ...source, service }));
}

export function cpuDefaults(host: LimitsHostFacts): { cpuCores: number; cpuPercent: number } {
  return { cpuCores: Math.max(1, Math.min(2, host.cores)), cpuPercent: 100 };
}

/** What the app asks for, at least 512 MB, never more than the server has. */
export function memoryDefault(host: LimitsHostFacts, minMemoryMb?: number): number {
  return Math.min(Math.max(minMemoryMb ?? 1024, 512), host.memoryMb);
}

export function diskDefault(): number {
  return DISK_DEFAULT_GB;
}

/** The quick picks for memory that fit on the server. */
export function memoryPresets(hostMemoryMb: number): number[] {
  return MEMORY_PRESETS_MB.filter((mb) => mb <= hostMemoryMb);
}

/** "Up to 1.5 cores of CPU time", or null with no CPU cap. */
export function cpuTimeText(limit: ServiceLimits): string | null {
  const cpus = limitCpus(limit);
  if (cpus === null) return null;
  return `Up to ${cpus} ${cpus === 1 ? 'core' : 'cores'} of CPU time`;
}

/** What to know before saving a memory cap: under the app's own need, or under what it uses. */
export function memoryWarnings(
  limit: ServiceLimits,
  minMemoryMb?: number,
  usageMb?: number,
): string[] {
  const memory = limit.memoryMb;
  if (typeof memory !== 'number') return [];
  const warnings: string[] = [];
  if (minMemoryMb && memory < minMemoryMb) {
    warnings.push(`This app needs about ${formatMemoryMb(minMemoryMb)} to run well.`);
  }
  if (usageMb && memory < usageMb) {
    warnings.push(
      `It uses ${formatMemoryMb(Math.round(usageMb))} now, so it would be stopped for running out of memory.`,
    );
  }
  return warnings;
}

/** Whether two drafts cap the same services the same way. */
export function sameLimits(a: readonly ServiceLimits[], b: readonly ServiceLimits[]): boolean {
  const left = a.map(clean).filter(hasLimits);
  const right = b.map(clean).filter(hasLimits);
  if (left.length !== right.length) return false;
  return left.every((limit) => {
    const other = right.find((item) => item.service === limit.service);
    return other !== undefined && FIELDS.every((field) => limit[field] === other[field]);
  });
}
