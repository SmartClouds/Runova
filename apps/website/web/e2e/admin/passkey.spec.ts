// Passkeys (E115) against the real API, with Chromium's virtual authenticator standing in for a
// phone or a security key: add one in Security, sign out, sign back in with it and no code, and
// remove it with the passkey as the proof.
import type { Page } from '@playwright/test';
import { createEditor, expect, newApiContext, SIGNED_OUT, signIn, test } from './fixtures';
import { nextCode } from './totp';

test.use({ storageState: SIGNED_OUT });
// The account has two-factor on, and each code works once, so the sign-in may wait on the clock.
test.describe.configure({ timeout: 120_000 });

/** A platform authenticator that makes discoverable passkeys and verifies the user without asking. */
async function addAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

test('adds a passkey, signs in with it and no code, then removes it with the passkey as proof', async ({
  browser,
  owner,
}, info) => {
  const account = await createEditor(owner, info.workerIndex);
  const api = await newApiContext();
  await signIn(api, account.email, account.password, await nextCode(account));
  const context = await browser.newContext({
    storageState: await api.storageState(),
    ignoreHTTPSErrors: true,
  });
  await api.dispose();
  const page = await context.newPage();
  await addAuthenticator(page);

  await page.goto('/account/security');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  const adding = page.locator('dialog[open]');
  await adding.getByLabel('Name it').fill('E2E laptop');
  await adding.getByLabel('Your password').fill(account.password);
  await adding.getByRole('button', { name: 'Add passkey' }).click();
  await expect(page.getByText('E2E laptop')).toBeVisible();

  await context.clearCookies();
  await page.goto('/account/sign-in?next=%2Faccount%2Fsecurity');
  await page.getByRole('button', { name: 'Use a passkey' }).click();
  await expect(page).toHaveURL(/\/account\/security$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();

  await page.getByRole('button', { name: 'Remove E2E laptop' }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Use a passkey instead' }).click();
  await expect(page.getByText('E2E laptop')).toHaveCount(0);

  await context.close();
});
