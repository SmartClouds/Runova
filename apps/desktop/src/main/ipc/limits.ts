import { type ServiceLimits, validateLimits } from '@runova/core';

/**
 * Resource caps as they cross IPC: a list of per-service caps with whole numbers in range. The
 * services and the server's size are checked where they are known (the App Store render, and the
 * core when it validates the revision).
 */

const MAX_SERVICES = 50;
const SERVICE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const FIELDS = ['cpuCores', 'cpuPercent', 'memoryMb', 'diskGb'] as const;

export function limitsInput(value: unknown): ServiceLimits[] {
  if (!Array.isArray(value)) throw new Error('The resource caps are not a list.');
  if (value.length > MAX_SERVICES) throw new Error(`Cap at most ${MAX_SERVICES} services.`);
  const limits: ServiceLimits[] = value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) throw new Error('A resource cap is not one.');
    const entry = item as Record<string, unknown>;
    if (typeof entry.service !== 'string' || !SERVICE.test(entry.service)) {
      throw new Error('A resource cap names a service that is not a service name.');
    }
    const limit: ServiceLimits = { service: entry.service };
    for (const field of FIELDS) {
      const number = entry[field];
      if (number === null || number === undefined) continue;
      if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
        throw new Error(`The caps of ${entry.service} must be whole numbers.`);
      }
      limit[field] = number;
    }
    return limit;
  });
  const checked = validateLimits(
    limits,
    limits.map((limit) => limit.service),
  );
  if (!checked.ok) throw new Error(checked.reason);
  return checked.limits;
}
