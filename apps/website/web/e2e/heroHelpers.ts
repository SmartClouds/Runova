import type { Page } from '@playwright/test';

export const hero = (page: Page) => page.locator('[data-hero]');
export const fallback = (page: Page) => page.locator('[data-hero-fallback]');
export const canvas = (page: Page) => page.locator('[data-hero] canvas');

/** Watches the page's scripts and reports whether one containing `marker` has been fetched. */
export function watchScripts(page: Page, marker: string) {
  const state = { loaded: false };
  page.on('response', async (response) => {
    if (!/\.m?js(\?|$)/.test(response.url())) return;
    const body = await response.text().catch(() => '');
    if (body.includes(marker)) state.loaded = true;
  });
  return state;
}

/**
 * Reports whether three.js has been fetched. The library keeps its `THREE.WebGLRenderer` log
 * prefix through minification, so it marks the chunk whatever its name.
 */
export const watchThree = (page: Page) => watchScripts(page, 'THREE.WebGLRenderer');

/**
 * Makes the page report 8 cores and 8 GB, so whether the hero counts the device as low-end does
 * not depend on the machine running the tests (a 4-core CI runner is low-end to it). Configurable,
 * so a test can still make the device low-end after this.
 */
export async function capableDevice(page: Page) {
  await page.addInitScript(() => {
    for (const name of ['hardwareConcurrency', 'deviceMemory']) {
      Object.defineProperty(Navigator.prototype, name, { get: () => 8, configurable: true });
    }
  });
}

/** Lets the island hydrate and any scene start, so a test that expects nothing waits long enough. */
export async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
}
