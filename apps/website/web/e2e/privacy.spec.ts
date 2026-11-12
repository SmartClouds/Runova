import { expect, test } from '@playwright/test';
import { PRIVACY_SECTIONS } from '../src/lib/privacy';

// The App Store and Google Play link to /privacy, often into an in-app browser on a phone. This
// runs against the production build, which enforces the CSP the dev server leaves out.

test('serves the policy with no console errors and no CSP violations', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));

  const response = await page.goto('/privacy');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Your work stays on your computer.',
  );
  await expect(page).toHaveTitle('Privacy policy | Runova');
  expect(problems).toEqual([]);
});

test('the list on the side follows the reader and jumps to a section', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/privacy');
  const toc = page.getByRole('navigation', { name: 'On this page' });
  await expect(toc.getByRole('link')).toHaveCount(PRIVACY_SECTIONS.length);

  await toc.getByRole('link', { name: 'How long we keep it' }).click();
  await expect(page).toHaveURL(/#how-long$/);
  await expect(page.locator('#how-long')).toBeInViewport();
  await expect(toc.getByRole('link', { name: 'How long we keep it' })).toHaveAttribute(
    'aria-current',
    /.+/,
  );
});

test('fits a phone, with a list to jump between sections', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/privacy');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);

  // The side list is for wide screens only, so a phone gets the folding one.
  await expect(page.getByRole('navigation', { name: 'On this page' })).toBeHidden();
  await page.getByText('Jump to a section').click();
  await page.getByRole('link', { name: 'Delete your account' }).first().click();
  await expect(page.locator('#delete-account')).toBeInViewport();
});

test('is linked from the footer of the other pages', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Privacy policy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
});
