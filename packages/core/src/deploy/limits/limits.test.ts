import { describe, expect, it } from 'vitest';
import {
  describeLimits,
  hasLimits,
  limitCpus,
  limitsToCompose,
  type ServiceLimits,
  validateLimits,
} from './limits.js';

const HOST = { cores: 8, memoryMb: 16_384, diskLimits: true };

describe('limitCpus', () => {
  it('is cores times the usage share', () => {
    expect(limitCpus({ service: 'app', cpuCores: 2, cpuPercent: 50 })).toBe(1);
    expect(limitCpus({ service: 'app', cpuCores: 3, cpuPercent: 25 })).toBe(0.75);
  });

  it('takes a missing share as the whole of the cores', () => {
    expect(limitCpus({ service: 'app', cpuCores: 4 })).toBe(4);
  });

  it('takes a missing core count as one core', () => {
    expect(limitCpus({ service: 'app', cpuPercent: 30 })).toBe(0.3);
  });

  it('rounds to two decimals, which is what Docker keeps', () => {
    expect(limitCpus({ service: 'app', cpuCores: 3, cpuPercent: 33 })).toBe(0.99);
  });

  it('is null with no CPU cap', () => {
    expect(limitCpus({ service: 'app', memoryMb: 512 })).toBeNull();
  });
});

describe('limitsToCompose', () => {
  it('writes the CPU and memory caps in both Compose forms', () => {
    expect(
      limitsToCompose({ service: 'app', cpuCores: 2, cpuPercent: 50, memoryMb: 2048 }),
    ).toEqual({
      cpus: 1,
      mem_limit: '2048m',
      memswap_limit: '2048m',
      deploy: { resources: { limits: { cpus: '1', memory: '2048m' } } },
    });
  });

  it('writes the disk cap as a storage option', () => {
    expect(limitsToCompose({ service: 'app', diskGb: 20 })).toEqual({
      storage_opt: { size: '20G' },
    });
  });

  it('writes nothing when nothing is capped', () => {
    expect(limitsToCompose({ service: 'app' })).toEqual({});
  });
});

describe('validateLimits', () => {
  const services = ['app', 'db'];

  it('accepts sensible caps and drops services with none', () => {
    const result = validateLimits(
      [
        { service: 'app', cpuCores: 2, cpuPercent: 50, memoryMb: 1024, diskGb: 10 },
        { service: 'db', cpuCores: null, memoryMb: null },
      ],
      services,
      HOST,
    );
    expect(result).toEqual({
      ok: true,
      limits: [{ service: 'app', cpuCores: 2, cpuPercent: 50, memoryMb: 1024, diskGb: 10 }],
    });
  });

  it('refuses a service the app does not have', () => {
    const result = validateLimits([{ service: 'web', memoryMb: 512 }], services, HOST);
    expect(result).toMatchObject({ ok: false, service: 'web' });
  });

  it('refuses the same service twice', () => {
    const result = validateLimits(
      [
        { service: 'app', memoryMb: 512 },
        { service: 'app', memoryMb: 256 },
      ],
      services,
      HOST,
    );
    expect(result).toMatchObject({ ok: false, service: 'app' });
  });

  it.each<[string, ServiceLimits]>([
    ['no cores', { service: 'app', cpuCores: 0 }],
    ['more cores than the server has', { service: 'app', cpuCores: 9 }],
    ['a fraction of a core', { service: 'app', cpuCores: 1.5 }],
    ['a share under 5%', { service: 'app', cpuPercent: 4 }],
    ['a share over 100%', { service: 'app', cpuPercent: 101 }],
    ['under 6 MB of memory', { service: 'app', memoryMb: 5 }],
    ['more memory than the server has', { service: 'app', memoryMb: 16_385 }],
    ['no disk', { service: 'app', diskGb: 0 }],
  ])('refuses %s', (_name, limit) => {
    expect(validateLimits([limit], services, HOST)).toMatchObject({ ok: false, service: 'app' });
  });

  it('refuses a disk cap on a server that cannot apply one', () => {
    const result = validateLimits([{ service: 'app', diskGb: 10 }], services, {
      ...HOST,
      diskLimits: false,
    });
    expect(result).toMatchObject({ ok: false, service: 'app' });
    if (!result.ok) expect(result.reason).toMatch(/disk/);
  });

  it('checks only the shape when the server is not known', () => {
    expect(validateLimits([{ service: 'app', cpuCores: 64, diskGb: 5 }], services)).toMatchObject({
      ok: true,
    });
  });
});

describe('describeLimits', () => {
  it('reads as a short line', () => {
    expect(
      describeLimits({ service: 'app', cpuCores: 2, cpuPercent: 50, memoryMb: 2048, diskGb: 20 }),
    ).toBe('2 cores at 50% · 2 GB RAM · 20 GB disk');
  });

  it('leaves out a share of 100% and writes odd memory in MB', () => {
    expect(describeLimits({ service: 'app', cpuCores: 1, memoryMb: 768 })).toBe(
      '1 core · 768 MB RAM',
    );
  });

  it('says so when nothing is capped', () => {
    expect(describeLimits({ service: 'app' })).toBe('No limits');
  });
});

describe('hasLimits', () => {
  it('is true only with a cap set', () => {
    expect(hasLimits({ service: 'app' })).toBe(false);
    expect(hasLimits({ service: 'app', cpuCores: null, memoryMb: null })).toBe(false);
    expect(hasLimits({ service: 'app', diskGb: 1 })).toBe(true);
  });
});
