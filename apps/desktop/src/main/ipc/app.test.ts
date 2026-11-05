import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { emit, loadIpc, useTempUserData } from '../../test/main/ipcHarness';

/**
 * The app window reporting the page it is on, so the next launch can open there. The updater and
 * terminal modules are stubbed: only the route channel is under test here.
 */

vi.mock('../updater', () => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  pauseDownload: vi.fn(),
  quitAndInstall: vi.fn(),
}));
vi.mock('./terminal', () => ({ preserveTerminalsOnQuit: vi.fn() }));

// The app channels reach the main window, the quit guard and the store. Vitest keeps the
// transformed files between the tests' imports, so loading them once here moves the cold
// transform (slow under coverage on the Mac runner's disk) out of the first test's time limit,
// as in aiAccess.test.ts.
await import('./app');

const userData = useTempUserData();

async function register(): Promise<typeof import('../lastRoute')> {
  await loadIpc(
    () => import('./app'),
    (module) => module.registerAppHandlers(),
  );
  return import('../lastRoute');
}

function savedRoute(): unknown {
  return JSON.parse(readFileSync(userData.dataFile('last-route.json'), 'utf-8')).route;
}

describe('app:setLastRoute', () => {
  it('saves the page the window reports', async () => {
    const lastRoute = await register();

    emit(IPC.app.setLastRoute, '/workspace/p1');
    lastRoute.flushLastRoute();

    expect(lastRoute.loadLastRoute()).toBe('/workspace/p1');
    expect(savedRoute()).toBe('/workspace/p1');
  });

  it('ignores a payload that is not an app page', async () => {
    const lastRoute = await register();

    emit(IPC.app.setLastRoute, '/usage');
    emit(IPC.app.setLastRoute, { route: '/settings' });
    emit(IPC.app.setLastRoute, 'https://evil.example');
    lastRoute.flushLastRoute();

    expect(savedRoute()).toBe('/usage');
  });
});
