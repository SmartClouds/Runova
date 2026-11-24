import { expect, test } from '@playwright/test';
import { ZONE_ID } from '../src/main/deploy/cloudflare/testing/recorded';
import { type LaunchedApp, launchApp } from './app';
import {
  E2E_CLOUDFLARE_TOKEN,
  type FakeCloudflareServer,
  startFakeCloudflare,
} from './fakeCloudflareServer';

/**
 * Cache purges in the built app, against the recorded Cloudflare fake on loopback: the zone
 * header's Purge cache menu opens the Caching tab with focus in the list, a folder goes out as a
 * prefix and a hostname as a host, and a full purge waits for the domain's name.
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

test('purges a folder, a hostname and everything from the header and the Caching tab', async () => {
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

  await page.getByRole('button', { name: 'Purge cache', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Choose URLs, folders or hostnames…' }).click();
  await expect(page.getByRole('tab', { name: 'Caching' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('URLs to purge')).toBeFocused();

  await page.getByRole('radio', { name: 'Folders' }).click();
  await page.getByLabel('Folders to purge').fill('https://example.com/blog/');
  await page.getByRole('button', { name: 'Purge these folders' }).click();
  await expect(page.getByLabel('Folders to purge')).toHaveValue('');

  await page.getByRole('radio', { name: 'Hostnames' }).click();
  await page.getByLabel('Hostnames to purge').fill('www.example.com');
  await page.getByRole('button', { name: 'Purge these hostnames' }).click();
  await expect(page.getByLabel('Hostnames to purge')).toHaveValue('');

  await page.getByRole('button', { name: 'Purge cache', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Purge everything…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Purge everything for example.com?' });
  const confirm = dialog.getByRole('button', { name: 'Purge everything' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/to confirm/).fill('example.com');
  await confirm.click();
  await expect(dialog).toBeHidden();

  const purges = cloudflare.fake
    .writes()
    .filter((request) => request.path === `/zones/${ZONE_ID}/purge_cache`)
    .map((request) => request.body);
  expect(purges).toEqual([
    { prefixes: ['example.com/blog/'] },
    { hosts: ['www.example.com'] },
    { purge_everything: true },
  ]);
});
