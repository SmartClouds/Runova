import { describe, expect, it } from 'vitest';
import { RUNOVA_CORE } from './coreLayout';

/** The paths and wire names a server core comes with. */
describe('coreLayout', () => {
  it('builds the paths from the core folder and unit', () => {
    expect(RUNOVA_CORE.releases).toBe('/opt/runova-core/releases');
    expect(RUNOVA_CORE.current).toBe('/opt/runova-core/current');
    expect(RUNOVA_CORE.binaryPath).toBe('/opt/runova-core/current/runova-core');
    expect(RUNOVA_CORE.socketPath).toBe('/run/runova-core/core.sock');
    expect(RUNOVA_CORE.unitFile).toBe('runova-core.service');
    expect(RUNOVA_CORE.unitPath).toBe('/etc/systemd/system/runova-core.service');
    expect(RUNOVA_CORE.host).toBe('runova-core');
  });
});
