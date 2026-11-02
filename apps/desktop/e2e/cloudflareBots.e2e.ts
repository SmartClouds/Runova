import { expect, test } from '@playwright/test';
import { ZONE_ID } from '../src/main/deploy/cloudflare/testing/recorded';
import { type LaunchedApp, launchApp } from './app';
import {
  E2E_CLOUDFLARE_TOKEN,
  type FakeCloudflareServer,
  startFakeCloudflare,
} from './fakeCloudflareServer';

/**
 * AI bot access in the built app, against the recorded Cloudflare fake on loopback: the header's
 * Block AI bots switch and the Security tab's card read the same Bot Management settings, so a
 * change in one shows in the other, and only the changed field is sent.
 */

let cloudflare: FakeCloudflareServer | undefined;
let launched: LaunchedApp | undefined;

test.beforeAll(async () => {
  cloudflare = await startFakeCloudflare();
});

test.afterAll(async () => {
  await cloudflare?.close();
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test('blocks AI bots from the header and turns on Bot Preference Sync in the Security tab', async () => {
  if (!cloudflare) throw new Error('The Cloudflare fake did not start');
  launched = await launchApp({
    settings: {},
    env: { RUNOVA_E2E_CLOUDFLARE_API: cloudflare.base },
  });
  const { page } = launched;

  await page.getByRole('link', { name: 'Deploy' }).click();
  await page.getByRole('button', { name: 'Manage Cloudflare' }).click();
  await page.getByLabel('API token').fill(E2E_CLOUDFLARE_TOKEN);
  await page.getByRole('button', { name: 'Save and check' }).click();
  await expect(
    page.getByRole('button', { name: 'Choose a domain, example.com is open' }),
  ).toBeVisible({ timeout: 30_000 });

  const quick = page.getByRole('group', { name: 'Quick switches' });
  const blockSwitch = quick.getByRole('switch', { name: 'Block AI bots' });
  await expect(blockSwitch).toHaveAttribute('aria-checked', 'false');
  await blockSwitch.click();
  await expect(blockSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(blockSwitch).toContainText('On, everywhere');

  await page.getByRole('tab', { name: 'Security' }).click();
  await expect(page.getByRole('radio', { name: 'Everywhere' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const sync = page.getByRole('switch', { name: 'Bot Preference Sync' });
  await sync.click();
  await expect(sync).toHaveAttribute('aria-checked', 'true');

  const writes = cloudflare.fake
    .writes()
    .filter((request) => request.path === `/zones/${ZONE_ID}/bot_management`)
    .map((request) => request.body);
  expect(writes).toEqual([{ ai_bots_protection: 'block' }, { bot_preference_sync_enabled: true }]);
});
