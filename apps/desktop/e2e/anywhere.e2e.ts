import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * Runova Anywhere (E61) through the built app. The e2e profile is signed out and reaches no
 * website, so this covers what a signed-out person sees: the tab opens first on the Remote page,
 * explains what it does and offers to sign in, and the other remote views are still one click away.
 * Connecting two computers is covered against a simulated website in the unit tests and against
 * the real API in the website's integration tests.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test('the Anywhere tab opens first and asks a signed-out person to sign in', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.evaluate(() => {
    window.location.hash = '#/remote';
  });
  const views = page.getByRole('navigation', { name: 'Remote views' });
  await expect(views.getByRole('button', { name: 'Anywhere', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(
    page.getByRole('heading', { name: 'Reach your computers from anywhere' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in to Runova' })).toBeEnabled();
  await expect(page.getByRole('group', { name: /^Runova ID not ready yet/ })).toBeVisible();

  await views.getByRole('button', { name: 'Host', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to host this computer' })).toBeVisible();
  await expect(page.getByText('Allow this machine to be controlled')).toBeHidden();

  // The main window answers the bridge for Anywhere even with no account behind it.
  const state = await page.evaluate(() =>
    (
      window as unknown as { runova: { anywhere: { getState(): Promise<{ status: string }> } } }
    ).runova.anywhere.getState(),
  );
  expect(state.status).toBe('signed-out');
  expect(errors).toEqual([]);
});
