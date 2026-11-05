import { describe, expect, it, vi } from 'vitest';

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
      /switched off in test runs/i,
    );
    expect(await service.rootOf('nuget')).toBeNull();
  });
});
