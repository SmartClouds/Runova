import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setElectronPath } from '../../test/main/electronMock';

const state = vi.hoisted(() => ({ e2e: false }));

vi.mock('../store', () => ({
  store: { getProjects: async () => [{ folderPath: 'D:\\projects\\app' }] },
}));
vi.mock('../testMode', () => ({
  get isE2E() {
    return state.e2e;
  },
}));

import { createRealSystemCleanup } from './deps';

describe('createRealSystemCleanup', () => {
  it('is on in a normal run, with no scan yet', () => {
    state.e2e = false;
    const service = createRealSystemCleanup();
    expect(service.status()).toEqual({ enabled: true });
    expect(service.current()).toBeNull();
  });

  it('is off in a test run that has no sandbox folder, and refuses to scan', async () => {
    state.e2e = true;
    delete process.env.RUNOVA_CLEANUP_SANDBOX;
    const service = createRealSystemCleanup();
    expect(service.status().enabled).toBe(false);
    await expect(service.scan({ requestId: 'r1', onEvent: () => undefined })).rejects.toThrow(
      /test runs leave it switched off/i,
    );
    expect(await service.rootOf('nuget')).toBeNull();
  });

  describe('in a test run with a sandbox', () => {
    let sandbox = '';
    afterEach(() => {
      delete process.env.RUNOVA_CLEANUP_SANDBOX;
      if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    });

    it('finds the caches the test built, even though the sandbox sits in the temp folder', async () => {
      // The temp folder is a protected folder for a real run. A sandbox is made inside it, so the
      // protection has to give way to the sandbox's own, stricter rule.
      setElectronPath('temp', realpathSync(tmpdir()));
      sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'runova-cleanup-sandbox-')));
      mkdirSync(join(sandbox, 'home', '.nuget', 'packages', 'acornima', '1.0.0'), {
        recursive: true,
      });
      state.e2e = true;
      process.env.RUNOVA_CLEANUP_SANDBOX = sandbox;
      const service = createRealSystemCleanup();
      expect(service.status()).toEqual({ enabled: true });
      expect(await service.rootOf('nuget')).toBe(join(sandbox, 'home', '.nuget', 'packages'));
    });
  });
});
