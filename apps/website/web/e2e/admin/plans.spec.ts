// Plans (E53) against the real API: an Admin changes what a type allows, and an account buys one
// by card. Stripe is a fake the stack starts; its webhook is signed here as Stripe signs it.
import { createHmac } from 'node:crypto';
import { request } from '@playwright/test';
import { antiforgeryToken, expect, SIGNED_OUT, test } from './fixtures';
import { ADMIN_BASE_URL, FAKE_STRIPE } from './stackConfig';

test.describe('as an Admin', () => {
  test.use({ storageState: async ({ adminSession }, use) => use(adminSession) });

  test('changes what a type allows and the plan cards follow', async ({ page }) => {
    await page.goto('/admin/plans');
    await page.getByRole('button', { name: 'Edit Go' }).click();
    const monitors = page.getByLabel('Online monitors');
    await monitors.fill('12');
    await page.getByRole('button', { name: 'Save type' }).click();

    await expect(page.getByRole('status')).toHaveText('Go is saved.');
    await expect(page.getByText(/^12 online monitors, checked every 5 minutes/)).toBeVisible();

    // Put it back for the other specs, which read the seeded limits.
    await page.getByRole('button', { name: 'Edit Go' }).click();
    await page.getByLabel('Online monitors').fill('10');
    await page.getByRole('button', { name: 'Save type' }).click();
    await expect(page.getByRole('status')).toHaveText('Go is saved.');
  });

  test('refuses crypto payments without their keys and names why', async ({ page }) => {
    await page.goto('/admin/plans/settings');
    await page.getByLabel('Take crypto payments').check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(
      page
        .getByText('Add the API key and the IPN secret before turning crypto payments on.')
        .first(),
    ).toBeVisible();
  });
});

test('an account buys Pro by card and its plan changes once Stripe says so', async ({
  page,
  owner,
}) => {
  const settings = await (await owner.get('/api/v1/payment-settings')).json();
  const saved = await owner.fetch('/api/v1/payment-settings', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/merge-patch+json',
      'if-match': `"${settings.version}"`,
      'X-XSRF-TOKEN': await antiforgeryToken(owner),
    },
    data: {
      stripeEnabled: true,
      stripeSecretKey: FAKE_STRIPE.secretKey,
      stripeWebhookSecret: FAKE_STRIPE.webhookSecret,
    },
  });
  expect(saved.status()).toBe(200);

  await page.goto('/account/plan');
  await expect(page.getByRole('heading', { name: 'Plan', level: 1 })).toBeVisible();
  await expect(page.getByText('Every account starts here.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Get Pro' }).click();
  await expect(page).toHaveURL(/\/checkout\/cs_\d+$/);
  await expect(page.getByRole('heading', { name: 'Fake Stripe checkout' })).toBeVisible();

  const me = await (await page.request.get('/api/v1/accounts/me')).json();
  const types = await (await page.request.get('/api/v1/account-types')).json();
  const pro = types.find((type: { key: string }) => type.key === 'pro');
  const event = JSON.stringify({
    id: `evt_e2e_${Date.now()}`,
    object: 'event',
    api_version: '2025-09-30.clover',
    type: 'customer.subscription.created',
    data: {
      object: {
        id: `sub_e2e_${me.id}`,
        object: 'subscription',
        customer: 'cus_e2e',
        status: 'active',
        cancel_at_period_end: false,
        metadata: { runova_user_id: String(me.id), runova_account_type_id: String(pro.id) },
        items: {
          object: 'list',
          data: [
            {
              id: 'si_e2e',
              object: 'subscription_item',
              current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
              price: { id: 'price_unknown', object: 'price' },
            },
          ],
        },
      },
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', FAKE_STRIPE.webhookSecret)
    .update(`${timestamp}.${event}`)
    .digest('hex');
  // As Stripe calls it: no cookie, so no session and no antiforgery token.
  const stripe = await request.newContext({
    baseURL: ADMIN_BASE_URL,
    ignoreHTTPSErrors: true,
    storageState: SIGNED_OUT,
  });
  const delivered = await stripe.post('/api/v1/stripe-events', {
    headers: {
      'Stripe-Signature': `t=${timestamp},v1=${signature}`,
      'content-type': 'application/json',
    },
    data: event,
  });
  expect(delivered.status(), await delivered.text()).toBe(200);
  await stripe.dispose();

  await page.goto('/account/plan');
  await expect(page.getByRole('heading', { level: 2, name: 'Pro Active' })).toBeVisible();
  await expect(page.getByText(/^Card · Renews on/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pro is your plan' })).toBeDisabled();
});
