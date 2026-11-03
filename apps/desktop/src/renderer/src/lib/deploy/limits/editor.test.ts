import { describe, expect, it } from 'vitest';
import {
  copyToAll,
  cpuDefaults,
  cpuTimeText,
  DISK_DEFAULT_GB,
  diskDefault,
  limitFor,
  memoryDefault,
  memoryPresets,
  memoryWarnings,
  sameLimits,
  setLimit,
} from './editor';

const HOST = { cores: 8, memoryMb: 16_384, diskLimits: true };
const SERVICES = ['ollama', 'open-webui'];

describe('limitFor', () => {
  it('is the saved caps, or none', () => {
    const value = [{ service: 'ollama', memoryMb: 2048 }];
    expect(limitFor(value, 'ollama')).toEqual({ service: 'ollama', memoryMb: 2048 });
    expect(limitFor(value, 'open-webui')).toEqual({ service: 'open-webui' });
  });
});

describe('setLimit', () => {
  it('replaces the service entry and keeps the order of the services', () => {
    const value = [{ service: 'open-webui', memoryMb: 512 }];
    expect(setLimit(value, SERVICES, { service: 'ollama', cpuCores: 2, cpuPercent: 100 })).toEqual([
      { service: 'ollama', cpuCores: 2, cpuPercent: 100 },
      { service: 'open-webui', memoryMb: 512 },
    ]);
  });

  it('drops a service once nothing is capped, and fields set to null', () => {
    const value = [{ service: 'ollama', memoryMb: 2048 }];
    expect(setLimit(value, SERVICES, { service: 'ollama', memoryMb: null })).toEqual([]);
    expect(setLimit([], SERVICES, { service: 'ollama', cpuCores: null, memoryMb: 1024 })).toEqual([
      { service: 'ollama', memoryMb: 1024 },
    ]);
  });
});

describe('copyToAll', () => {
  it('gives every service the caps of one', () => {
    const value = [{ service: 'ollama', cpuCores: 4, cpuPercent: 50, memoryMb: 8192 }];
    expect(copyToAll(value, SERVICES, 'ollama')).toEqual([
      { service: 'ollama', cpuCores: 4, cpuPercent: 50, memoryMb: 8192 },
      { service: 'open-webui', cpuCores: 4, cpuPercent: 50, memoryMb: 8192 },
    ]);
  });

  it('clears every service when the source has none', () => {
    expect(copyToAll([{ service: 'open-webui', memoryMb: 512 }], SERVICES, 'ollama')).toEqual([]);
  });
});

describe('defaults', () => {
  it('starts the CPU at two cores, or fewer on a small server', () => {
    expect(cpuDefaults(HOST)).toEqual({ cpuCores: 2, cpuPercent: 100 });
    expect(cpuDefaults({ ...HOST, cores: 1 })).toEqual({ cpuCores: 1, cpuPercent: 100 });
  });

  it('starts the memory at what the app asks for, at least 512 MB, never past the server', () => {
    expect(memoryDefault(HOST)).toBe(1024);
    expect(memoryDefault(HOST, 8192)).toBe(8192);
    expect(memoryDefault(HOST, 128)).toBe(512);
    expect(memoryDefault({ ...HOST, memoryMb: 4096 }, 8192)).toBe(4096);
  });

  it('starts the disk at 20 GB', () => {
    expect(diskDefault()).toBe(DISK_DEFAULT_GB);
    expect(DISK_DEFAULT_GB).toBe(20);
  });
});

describe('memoryPresets', () => {
  it('offers only what the server has', () => {
    expect(memoryPresets(16_384)).toEqual([512, 1024, 2048, 4096, 8192]);
    expect(memoryPresets(3000)).toEqual([512, 1024, 2048]);
  });
});

describe('cpuTimeText', () => {
  it('says how much CPU time the caps come to', () => {
    expect(cpuTimeText({ service: 'a', cpuCores: 2, cpuPercent: 50 })).toBe(
      'Up to 1 core of CPU time',
    );
    expect(cpuTimeText({ service: 'a', cpuCores: 3, cpuPercent: 25 })).toBe(
      'Up to 0.75 cores of CPU time',
    );
    expect(cpuTimeText({ service: 'a', cpuCores: 3, cpuPercent: 50 })).toBe(
      'Up to 1.5 cores of CPU time',
    );
    expect(cpuTimeText({ service: 'a' })).toBeNull();
  });
});

describe('memoryWarnings', () => {
  it('warns under what the app needs', () => {
    expect(memoryWarnings({ service: 'a', memoryMb: 4096 }, 8192)).toEqual([
      'This app needs about 8 GB to run well.',
    ]);
  });

  it('warns under what the container uses now', () => {
    expect(memoryWarnings({ service: 'a', memoryMb: 1024 }, undefined, 1228.8)).toEqual([
      'It uses 1.2 GB now, so it would be stopped for running out of memory.',
    ]);
  });

  it('is quiet with enough memory or no cap', () => {
    expect(memoryWarnings({ service: 'a', memoryMb: 8192 }, 8192, 500)).toEqual([]);
    expect(memoryWarnings({ service: 'a' }, 8192, 500)).toEqual([]);
  });
});

describe('sameLimits', () => {
  it('compares by service, whatever the order', () => {
    const a = [
      { service: 'ollama', memoryMb: 2048 },
      { service: 'open-webui', cpuCores: 1 },
    ];
    expect(sameLimits(a, [...a].reverse())).toBe(true);
    expect(sameLimits(a, [{ service: 'ollama', memoryMb: 2048 }])).toBe(false);
    expect(
      sameLimits([{ service: 'x', memoryMb: 1, cpuCores: null }], [{ service: 'x', memoryMb: 1 }]),
    ).toBe(true);
  });
});
