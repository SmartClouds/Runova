// Continue with a provider in a real browser (E116), against the stack's fake Microsoft. The fake is
// on another site, so the way back is a navigation another site started, which is what decides
// whether the browser sends Runova's SameSite=Strict session cookie. The API's own tests can not
// see this: their cookie jar ignores SameSite.
import type { Page } from '@playwright/test';
import { apiCall, expect, SIGNED_OUT, test } from './fixtures';

test.use({ storageState: SIGNED_OUT });

let people = 0;
const newEmail = (workerIndex: number) =>
  `microsoft-${workerIndex}-${++people}-${Date.now()}@e2e.runovahq.test`;

/** Answers the fake Microsoft's page as `email`, with a fresh account id unless one is given. */
async function approveAtMicrosoft(page: Page, email: string, subject?: string) {
  await expect(page.getByRole('heading', { name: 'Sign in to Microsoft' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  if (subject) await page.getByLabel('Account id').fill(subject);
  await page.getByRole('button', { name: 'Continue' }).click();
}

test('a new person continues with Microsoft from the sign-in page and lands signed in', async ({
  page,
}, info) => {
  await page.goto('/account/sign-in');
  await page.getByRole('link', { name: 'Continue with Microsoft' }).click();
  await approveAtMicrosoft(page, newEmail(info.workerIndex));

  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Hello, Sam' })).toBeVisible();
});

test('signing in with Microsoft keeps the session across the next page', async ({ page }, info) => {
  await page.goto('/api/v1/external-sign-ins/microsoft?returnUrl=%2Faccount%2Fsecurity');
  await approveAtMicrosoft(page, newEmail(info.workerIndex));

  await expect(page).toHaveURL(/\/account\/security$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
  await page.goto('/account/profile');
  await expect(page).toHaveURL(/\/account\/profile$/);
});

test('a signed-in account links another Microsoft login from Security', async ({ page }, info) => {
  await page.goto('/api/v1/external-sign-ins/microsoft?returnUrl=%2Faccount');
  await approveAtMicrosoft(page, newEmail(info.workerIndex));
  await expect(page).toHaveURL(/\/account$/);

  // Linking needs step-up proof first; a Microsoft-only account just signed in, which is the proof.
  // The Security page can not offer a second Microsoft login, so the test asks for the grant itself.
  await apiCall(page.request, 'POST', '/accounts/me/login-link-grants', {
    password: null,
    code: null,
  });
  await page.goto('/api/v1/external-sign-ins/microsoft?link=true&returnUrl=%2Faccount%2Fsecurity');
  await approveAtMicrosoft(page, newEmail(info.workerIndex), crypto.randomUUID());

  await expect(page).toHaveURL(/\/account\/security\?linked=microsoft$/);
  await expect(page.getByText('Microsoft is linked')).toBeVisible();
});
