import { expect, test } from '@playwright/test';
import { NEW_ZONE_NAME_SERVERS } from '../src/main/deploy/cloudflare/testing/fakeCloudflare';
import { type LaunchedApp, launchApp } from './app';
import {
  E2E_CLOUDFLARE_TOKEN,
  type FakeCloudflareServer,
  startFakeCloudflare,
} from './fakeCloudflareServer';

/**
 * Adding a domain in the built app, against the recorded Cloudflare fake on loopback: the domain
 * is typed as a pasted web address, Cloudflare makes the zone, the registrar steps show its name
 * servers, and the new zone opens on its DNS records with a way to check the name servers again.
 */

let cloudflare: FakeCloudflareServer | undefined;
let launched: LaunchedApp | undefined;

test.beforeAll(async () => {
  cloudflare = await startFakeCloudflare({ grants: { zone: 'edit' } });
});

test.afterAll(async () => {
  await cloudflare?.close();
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test('adds a domain, shows its name servers and opens it', async () => {
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
  const picker = page.getByRole('button', { name: 'Choose a domain, example.com is open' });
  await expect(picker).toBeVisible({ timeout: 30_000 });

  await picker.click();
  await page.getByRole('button', { name: 'Add domain' }).click();
  // The picker's closing animation does not run in this window, so its list can linger in the
  // DOM; everything below is looked for inside the card.
  const card = page.getByRole('region', { name: 'Add a domain' });
  await expect(card).toBeVisible();
  await expect(card.getByText('Demo Account')).toBeVisible();
  await card.getByRole('textbox', { name: 'Domain' }).fill('https://New-Site.org/');
  await card.getByRole('button', { name: 'Add domain' }).click();

  await expect(
    page.getByRole('heading', { name: 'Point new-site.org at Cloudflare' }),
  ).toBeVisible();
  const servers = page.getByRole('list', { name: 'Cloudflare name servers' });
  for (const server of NEW_ZONE_NAME_SERVERS) await expect(servers).toContainText(server);
  const made = cloudflare.fake.writes().find((request) => request.path === '/zones');
  expect(made?.body).toMatchObject({ name: 'new-site.org', type: 'full' });

  await page.getByRole('button', { name: 'Open new-site.org' }).click();
  await expect(page.getByRole('heading', { name: 'new-site.org' })).toBeVisible();
  await page.getByRole('button', { name: 'Check name servers now' }).click();
  await expect(page.getByText(/Cloudflare is checking the name servers/)).toBeVisible();
  expect(
    cloudflare.fake.requests.some(
      (request) => request.method === 'PUT' && request.path.endsWith('/activation_check'),
    ),
  ).toBe(true);
});
