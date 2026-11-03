import { describe, expect, it } from 'vitest';
import { sampleDockerStatus } from '../../../../../shared/deploy/testing/fakeDockerData';
import { limitsHostOf } from './host';

describe('limitsHostOf', () => {
  it('reads the cores, memory and disk support the core reports', () => {
    expect(
      limitsHostOf(sampleDockerStatus({ diskLimits: true, diskLimitNote: undefined })),
    ).toEqual({
      cores: 4,
      memoryMb: 8192,
      diskLimits: true,
      diskNote: null,
    });
    expect(limitsHostOf(sampleDockerStatus())?.diskNote).toMatch(/overlayfs/);
  });

  it('is null for a core too old to report them, or no status yet', () => {
    expect(
      limitsHostOf(sampleDockerStatus({ cpus: undefined, memoryBytes: undefined })),
    ).toBeNull();
    expect(limitsHostOf(undefined)).toBeNull();
  });
});
