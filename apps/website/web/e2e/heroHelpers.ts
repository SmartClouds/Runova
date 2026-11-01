import type { Page } from '@playwright/test';

export const hero = (page: Page) => page.locator('[data-hero]');
export const demoSummary = (page: Page) => page.locator('[data-demo-summary]');

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

/** Lets the page's scripts run, so a test that expects nothing to happen waits long enough. */
export async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
}
