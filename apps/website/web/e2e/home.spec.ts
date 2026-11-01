import { expect, type Page, test } from '@playwright/test';
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

/** Makes the browser present itself as another system, userAgentData included. */
async function emulate(page: Page, userAgent: string, platform: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent,
    userAgentMetadata: {
      platform,
      platformVersion: '',
      architecture: 'x86',
      bitness: '64',
      model: '',
      mobile: platform === 'Android',
    },
  });
}

const SYSTEMS = [
  {
    platform: 'Windows',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    label: 'Download for Windows',
    href: '/download/windows/latest',
  },
  {
    platform: 'macOS',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    label: 'Download for macOS',
    href: '/download/macos/latest',
  },
  {
    platform: 'Linux',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    label: 'Download for Linux',
    href: '/download/linux/latest',
  },
  {
    platform: 'Android',
    userAgent:
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36',
    label: 'Download Runova',
    href: '/download',
  },
];

test.describe('home page download button', () => {
  const primary = (page: Page) => page.locator('#download [data-download-primary]');
  const trigger = (page: Page) => page.locator('#download [data-download-trigger]');
  const menu = (page: Page) => page.locator('#cta-download-menu');

  for (const system of SYSTEMS) {
    test(`names the visitor's system: ${system.platform}`, async ({ page }) => {
      await emulate(page, system.userAgent, system.platform);
      await page.goto('/');
      await expect(primary(page)).toHaveText(system.label);
      await expect(primary(page)).toHaveAttribute('href', system.href);
    });
  }

  test('opens its menu from the keyboard and gives focus back on Escape', async ({ page }) => {
    await page.goto('/');
    await expect(menu(page)).toBeHidden();
    await trigger(page).focus();
    await page.keyboard.press('ArrowDown');
    await expect(menu(page)).toBeVisible();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    const items = menu(page).getByRole('menuitem');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('closes its menu on a click outside', async ({ page }) => {
    await page.goto('/');
    await trigger(page).click();
    await expect(menu(page)).toBeVisible();
    await page.locator('#download-title').click();
    await expect(menu(page)).toBeHidden();
  });

  test('makes the system picked in the menu the main download', async ({ page }) => {
    await emulate(page, SYSTEMS[0].userAgent, SYSTEMS[0].platform);
    await page.goto('/');
    // Keep the page here instead of following the download.
    await page.evaluate(() =>
      document.addEventListener('click', (event) => event.preventDefault(), { capture: true }),
    );
    await trigger(page).click();
    await menu(page).getByRole('menuitem', { name: /Linux/ }).click();
    await expect(menu(page)).toBeHidden();
    await expect(primary(page)).toHaveText('Download for Linux');
    await expect(primary(page)).toHaveAttribute('href', '/download/linux/latest');
    await trigger(page).click();
    await expect(menu(page).locator('[data-selected]')).toHaveText(/Linux/);
  });

  test('links to an installer through /download/<os>/latest', async ({ request }) => {
    const response = await request.get('/download/windows/latest', { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers().location).toMatch(/\/Runova-Setup-[\d.]+\.exe$/);
    const unknown = await request.get('/download/android/latest', { maxRedirects: 0 });
    expect(unknown.status()).toBe(404);
  });

  for (const colorScheme of ['dark', 'light'] as const) {
    test(`lights up when the system prefers ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.goto('/');
      await expect(page.locator('#hero')).toHaveAttribute('data-beam', /^(on|still|fallback)$/);
      await expect(page.locator('header [data-beam-source]')).toHaveAttribute(
        'data-beam-struck',
        '',
        { timeout: 5_000 },
      );
    });
  }

  test('shows the light through the header at the top of the page only', async ({ page }) => {
    await page.goto('/');
    const header = page.locator('body > header');
    await expect(header).toHaveAttribute('data-clear', '');
    await expect(header).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.mouse.wheel(0, 400);
    await expect(header).not.toHaveAttribute('data-clear', '');
  });

  test('keeps the open menu above the rest of the call to action on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/');
    await trigger(page).click();
    const item = menu(page).getByRole('menuitem').nth(1);
    await item.scrollIntoViewIfNeeded();
    const box = await item.boundingBox();
    if (!box) throw new Error('the menu item has no box');
    const onTop = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('[role="menuitem"]') !== null,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(onTop).toBe(true);
  });
});
