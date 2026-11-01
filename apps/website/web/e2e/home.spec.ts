import { expect, test } from '@playwright/test';
import { scanHtml } from '../tests/helpers/textScan';
import { demoSummary, hero, settle, watchScripts } from './heroHelpers';

test.describe('home page hero', () => {
  test('plays the workspace run once, from working to done', async ({ page }) => {
    await page.goto('/');
    await expect(hero(page)).toHaveAttribute('data-state', 'playing');
    await expect(demoSummary(page)).toHaveText('3 working');
    await expect(hero(page)).toHaveAttribute('data-state', 'done', { timeout: 15_000 });
    await expect(demoSummary(page)).toHaveText('1 waiting on you · 2 done');
    await expect(page.locator('[data-demo-tokens]')).toHaveText('184.2k tokens');

    // Once done it stays done: scrolling away and back does not replay it.
    await page.locator('#download').scrollIntoViewIfNeeded();
    await hero(page).scrollIntoViewIfNeeded();
    await settle(page);
    await expect(hero(page)).toHaveAttribute('data-state', 'done');
  });

  test('waits until the hero is on screen before it starts', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto('/#download');
    await settle(page);
    await expect(hero(page)).not.toBeInViewport();
    await expect(hero(page)).toHaveAttribute('data-state', 'idle');

    await hero(page).scrollIntoViewIfNeeded();
    await expect(hero(page)).toHaveAttribute('data-state', /playing|done/);
  });

  test('ends on the same picture the server sends', async ({ browser, page }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const still = await context.newPage();
    await still.goto('/');
    const before = await still.locator('.demo-window').textContent();
    await context.close();

    await page.goto('/');
    await expect(hero(page)).toHaveAttribute('data-state', 'done', { timeout: 15_000 });
    expect(await page.locator('.demo-window').textContent()).toBe(before);
  });

  test('with reduced motion, shows the finished run at once and nothing moves', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(hero(page)).toHaveAttribute('data-state', 'done');
    await expect(demoSummary(page)).toHaveText('1 waiting on you · 2 done');
    const animated = await page.evaluate(() => document.getAnimations().length);
    expect(animated).toBe(0);
  });

  test('without JavaScript, the finished run is there', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/');
    await expect(hero(page)).toBeVisible();
    await expect(page.getByText('Discount codes are in. All 21 tests pass.')).toBeVisible();
    await expect(demoSummary(page)).toHaveText('1 waiting on you · 2 done');
    await context.close();
  });

  test('loads no WebGL library and starts no worker', async ({ page }) => {
    const three = watchScripts(page, 'THREE.WebGLRenderer');
    const workers: string[] = [];
    page.on('worker', (worker) => workers.push(worker.url()));
    await page.goto('/');
    await settle(page);
    expect(three.loaded).toBe(false);
    expect(workers).toEqual([]);
  });

  test('shows two panes on a phone and all four on a desktop', async ({ page }) => {
    const panes = page.locator('.demo-pane');
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/');
    await expect(panes.filter({ visible: true })).toHaveCount(2);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(panes.filter({ visible: true })).toHaveCount(4);
  });
});

test.describe('home page', () => {
  test('the built HTML passes the forbidden phrase and em dash scan', async ({ request }) => {
    const response = await request.get('/');
    expect(response.ok()).toBe(true);
    expect(scanHtml(await response.text())).toEqual([]);
  });

  test('has no horizontal scroll at 320px wide', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });

  test('never downloads React', async ({ page }) => {
    const react = watchScripts(page, 'https://react.dev/errors/');
    await page.goto('/');
    await expect(hero(page)).toHaveAttribute('data-state', /playing|done/, { timeout: 15_000 });
    await settle(page);
    expect(react.loaded).toBe(false);
  });

  test('the download buttons lead to /download', async ({ page }) => {
    await page.goto('/');
    const links = page.locator('a[href="/download"]');
    expect(await links.count()).toBeGreaterThanOrEqual(2);
    await expect(links.first()).toBeVisible();
  });

  test('copies the winget command', async ({ context, page }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    const button = page.getByRole('button', { name: 'Copy the winget command' });
    await button.click();
    await expect(page.locator('[data-copy-status]')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'winget install SmartClouds.Runova',
    );
  });

  test('later sections fade in as they scroll into view', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const cta = page.locator('#download [data-reveal]');
    await expect(cta).toHaveAttribute('data-reveal', 'waiting');
    await cta.scrollIntoViewIfNeeded();
    await expect(cta).toHaveAttribute('data-reveal', 'shown');
    await expect(cta).toHaveCSS('opacity', '1');
  });

  test('no link on the page is underlined', async ({ page }) => {
    await page.goto('/');
    const underlined = await page.evaluate(() =>
      [...document.querySelectorAll('a')]
        .filter((link) => getComputedStyle(link).textDecorationLine.includes('underline'))
        .map((link) => link.textContent?.trim()),
    );
    expect(underlined).toEqual([]);
  });
});
