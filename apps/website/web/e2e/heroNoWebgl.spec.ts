import { expect, test } from '@playwright/test';
import { canvas, capableDevice, fallback, hero, settle, watchThree } from './heroHelpers';

// The scene's WebGL context lives in a worker, where an init script cannot reach, so this takes
// the GPU away from the whole browser, like a machine whose GPU Chrome blocks. --disable-webgl
// and --disable-3d-apis leave WebGL on for an OffscreenCanvas.
test.use({ launchOptions: { args: ['--disable-gpu', '--disable-software-rasterizer'] } });

test('without WebGL, the hero shows the static image and never loads three.js', async ({
  page,
}) => {
  // Otherwise a low-end machine stops at that check, before WebGL is looked at.
  await capableDevice(page);
  const three = watchThree(page);
  await page.goto('/');
  await settle(page);

  await expect(hero(page)).toHaveAttribute('data-state', 'static');
  await expect(hero(page)).toHaveAttribute('data-reason', 'no-webgl');
  await expect(fallback(page)).toBeVisible();
  await expect(canvas(page)).toHaveCount(0);
  expect(three.loaded).toBe(false);
});
