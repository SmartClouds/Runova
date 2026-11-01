import { join } from 'node:path';

// Playwright loads these files as CommonJS (the package has no "type": "module"), so __dirname
// is what's available here, not import.meta.
export const APP_ROOT = join(__dirname, '..');

/**
 * Holds every run's app build (see globalSetup) and the DevHost build lock, which all runs on the
 * machine share.
 */
export const E2E_OUT_DIR = join(APP_ROOT, 'out-e2e');

/** globalSetup puts the folder of the build this run uses here, and the workers inherit it. */
export const E2E_BUILD_ENV = 'RUNOVA_E2E_BUILD_DIR';

/** The main entry of the app build this run launches. */
export function appMainEntry(): string {
  const dir = process.env[E2E_BUILD_ENV];
  if (!dir) throw new Error(`${E2E_BUILD_ENV} is not set; run the specs through Playwright`);
  return join(dir, 'main', 'index.mjs');
}

/**
 * Where the app's own stdout/stderr and the terminal host's log are kept, next to the Playwright
 * report so CI uploads them. Main-process warnings never reach the renderer, so without these a
 * failure on another OS has nothing behind it but a screenshot.
 */
export const MAIN_LOG_DIR = join(APP_ROOT, 'test-results', 'main-process');
