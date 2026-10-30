import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

const homes: string[] = [];

/**
 * The website screenshots run the app on a home folder of their own. On Windows Electron asks
 * the OS for the user folders, which it cannot find for a made-up profile, so Studio's library
 * root (under Videos) threw "Failed to get 'videos' path".
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function loadWithHome(home: string): Promise<void> {
  vi.stubEnv('RUNOVA_E2E', '1');
  vi.stubEnv('RUNOVA_E2E_HOME', home);
  vi.resetModules();
  await import('./testMode');
}

describe('the e2e home folder', () => {
  it('moves home and the user folders under it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'runova-e2e-home-'));
    homes.push(home);
    await loadWithHome(home);
    expect(existsSync(join(home, 'Videos'))).toBe(true);
    expect(app.getPath('home')).toBe(home);
    expect(app.getPath('videos')).toBe(join(home, 'Videos'));
    expect(app.getPath('documents')).toBe(join(home, 'Documents'));
    expect(app.getPath('downloads')).toBe(join(home, 'Downloads'));
    expect(app.getPath('desktop')).toBe(join(home, 'Desktop'));
  });
});
