import { expect, test } from '@playwright/test';
import { scanHtml } from '../tests/helpers/textScan';
import {
  canvas,
  capableDevice,
  fallback,
  hero,
  settle,
  watchScripts,
  watchThree,
} from './heroHelpers';

test.beforeEach(({ page }) => capableDevice(page));

test.describe('home page hero', () => {
  test('loads three.js only once the hero is visible, then runs the scene', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    const three = watchThree(page);

    // Open the page scrolled to the closing call to action, with the hero out of view.
    await page.goto('/#download');
    await settle(page);
    await expect(hero(page)).not.toBeInViewport();
    expect(three.loaded).toBe(false);
    await expect(canvas(page)).toHaveCount(0);

    await hero(page).scrollIntoViewIfNeeded();
    await expect(hero(page)).toHaveAttribute('data-state', 'running', { timeout: 15_000 });
    // The response handler reads the chunk's body asynchronously, so it can finish after the scene
    // reports running.
    await expect.poll(() => three.loaded).toBe(true);
    await expect(canvas(page)).toBeVisible();
    await expect(fallback(page)).toHaveCSS('opacity', '0');
  });

  test('draws the scene in a worker, off the main thread', async ({ page }) => {
    await page.goto('/');
    await expect(hero(page)).toHaveAttribute('data-state', 'running', { timeout: 15_000 });
    // A canvas handed to a worker with transferControlToOffscreen refuses getContext.
    const transferred = await canvas(page).evaluate((element) => {
      try {
        (element as HTMLCanvasElement).getContext('2d');
        return false;
      } catch {
        return true;
      }
    });
    expect(transferred).toBe(true);
  });

  test('starts the hero worker only after the first contentful paint', async ({ page }) => {
    await page.goto('/');
    await expect(hero(page)).toHaveAttribute('data-state', 'running', { timeout: 15_000 });
    const times = await page.evaluate(() => ({
      paint: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
      worker: performance
        .getEntriesByType('resource')
        .find((entry) => entry.name.includes('/heroWorker'))?.startTime,
    }));
    expect(times.paint).toBeGreaterThan(0);
    expect(times.worker).toBeGreaterThan(times.paint ?? Infinity);
  });

  test('pauses the scene when the hero leaves the viewport and resumes when it returns', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto('/');
    await expect(hero(page)).toHaveAttribute('data-state', 'running', { timeout: 15_000 });

    await page.locator('#download').scrollIntoViewIfNeeded();
    await expect(hero(page)).toHaveAttribute('data-state', 'paused');

    await hero(page).scrollIntoViewIfNeeded();
    await expect(hero(page)).toHaveAttribute('data-state', 'running');
  });

  test('with reduced motion, shows the static image and never loads three.js', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const three = watchThree(page);
    await page.goto('/');
    await settle(page);

    await expect(hero(page)).toHaveAttribute('data-state', 'static');
    await expect(hero(page)).toHaveAttribute('data-reason', 'reduced-motion');
    await expect(fallback(page)).toBeVisible();
    await expect(fallback(page)).toHaveCSS('opacity', '1');
    await expect(canvas(page)).toHaveCount(0);
    expect(three.loaded).toBe(false);
  });

  test('on a low-end device, shows the static image and never loads three.js', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 4 });
    });
    const three = watchThree(page);
    await page.goto('/');
    await settle(page);

    await expect(hero(page)).toHaveAttribute('data-reason', 'low-end');
    await expect(fallback(page)).toBeVisible();
    expect(three.loaded).toBe(false);
  });

  test('without JavaScript, the static image is there', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/');
    await expect(fallback(page)).toBeVisible();
    await context.close();
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
    await expect(hero(page)).toHaveAttribute('data-state', 'running', { timeout: 15_000 });
    await settle(page);
    expect(react.loaded).toBe(false);
  });

  test('the download buttons lead to /download', async ({ page }) => {
    await page.goto('/');
    const links = page.locator('a[href="/download"]');
    expect(await links.count()).toBeGreaterThanOrEqual(2);
    await expect(links.first()).toBeVisible();
  });
});
