import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * Sending files (E112) through the built app. The e2e profile is signed out and reaches no
 * website, so this covers what a signed-out person sees on the Send files tab, and that main
 * answers the tab's calls. Sending between two computers is covered against a simulated website
 * in the unit tests, and the hub's rules against the real API in the website's integration tests.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test('the Send files tab asks a signed-out person to sign in, and main answers it', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.evaluate(() => {
    window.location.hash = '#/remote?tab=send';
  });
  const views = page.getByRole('navigation', { name: 'Remote views' });
  await expect(views.getByRole('button', { name: 'Send files', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(
    page.getByRole('heading', { name: 'Sign in to send files', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in to Runova', exact: true })).toBeEnabled();

  // The handlers are registered at start-up, so the tab's first call is answered.
  const state = await page.evaluate(() =>
    (
      window as unknown as {
        runova: { fileSend: { getState(): Promise<{ available: boolean; batches: unknown[] }> } };
      }
    ).runova.fileSend.getState(),
  );
  expect(state).toMatchObject({ available: false, batches: [] });

  // Nothing is moving, so the status bar has nothing to say about it.
  await expect(page.getByRole('button', { name: /^Sending files|^Receiving files/ })).toHaveCount(
    0,
  );
  expect(errors).toEqual([]);
});
