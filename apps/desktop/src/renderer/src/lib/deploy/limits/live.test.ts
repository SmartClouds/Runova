import { describe, expect, it } from 'vitest';
import { liveLimitsOf, liveRequestOf } from './live';

const HOST = { cores: 8, memoryMb: 16_384, diskLimits: false };
const MB = 1024 * 1024;

describe('liveLimitsOf', () => {
  it('reads cores of CPU time back as cores and a share', () => {
    expect(liveLimitsOf('tool', { cpuLimit: 1.5, memoryLimitBytes: 512 * MB }, HOST)).toEqual({
      service: 'tool',
      cpuCores: 2,
      cpuPercent: 75,
      memoryMb: 512,
    });
    expect(liveLimitsOf('tool', { cpuLimit: 2 }, HOST)).toEqual({
      service: 'tool',
      cpuCores: 2,
      cpuPercent: 100,
    });
  });

  it('takes a cap as big as the server as no cap', () => {
    expect(liveLimitsOf('tool', { cpuLimit: 8, memoryLimitBytes: 16_384 * MB }, HOST)).toEqual({
      service: 'tool',
    });
    expect(liveLimitsOf('tool', {}, HOST)).toEqual({ service: 'tool' });
  });
});

describe('liveRequestOf', () => {
  it('is cores of CPU time and MB, or null for none', () => {
    expect(
      liveRequestOf([{ service: 'tool', cpuCores: 2, cpuPercent: 50, memoryMb: 256 }]),
    ).toEqual({
      cpus: 1,
      memoryMb: 256,
    });
    expect(liveRequestOf([])).toEqual({ cpus: null, memoryMb: null });
  });
});
