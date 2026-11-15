import { expect, test } from '@playwright/test';
import { dnsRecord, ZONE_ID } from '../src/main/deploy/cloudflare/testing/recorded';
import { type LaunchedApp, launchApp } from './app';
import {
  E2E_CLOUDFLARE_TOKEN,
  type FakeCloudflareServer,
  startFakeCloudflare,
} from './fakeCloudflareServer';

/**
 * The email code gate in the built app (E96): the recorded Cloudflare fake on loopback stands in
 * for api.cloudflare.com. Email codes are turned on for the account with a team name, a gate goes
 * on a name with its people and session, is changed, a name gets Cloudflare's proxy so a gate can
 * go on it, and the gate comes off again.
 */

let cloudflare: FakeCloudflareServer | undefined;
let launched: LaunchedApp | undefined;

function record(id: string, name: string, proxied: boolean) {
  return { ...dnsRecord, id: id.repeat(32), type: 'A', name, content: '203.0.113.10', proxied };
}

test.beforeAll(async () => {
  cloudflare = await startFakeCloudflare({
    zones: [
      {
        id: ZONE_ID,
        name: 'example.com',
        records: [record('a', 'app.example.com', true), record('b', 'shop.example.com', false)],
      },
    ],
  });
});

test.afterAll(async () => {
  await cloudflare?.close();
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test('turns email codes on, gates a name, changes it and takes it off', async () => {
  if (!cloudflare) throw new Error('The Cloudflare fake did not start');
  const fake = cloudflare.fake;
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

  // Email codes for the account, once, with a team name.
  await page.getByRole('tab', { name: 'Access' }).click();
  const app = page.getByRole('listitem', { name: 'app.example.com' });
  await expect(app.getByText('Open to everyone')).toBeVisible();
  await expect(app.getByRole('switch')).toBeDisabled();
  await page.getByLabel('Team name').fill('acme');
  await expect(page.getByText('acme.cloudflareaccess.com')).toBeVisible();
  await page.getByRole('button', { name: 'Turn on email codes' }).click();
  await expect(app.getByRole('switch')).toBeEnabled();
  expect([...fake.identityProviders.values()].flat()).toEqual([
    expect.objectContaining({ type: 'onetimepin' }),
  ]);

  // A gate on app.example.com, with a person, a whole domain and seven days.
  await app.getByRole('switch', { name: 'Email code for app.example.com' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ask for an email code' });
  await dialog.getByLabel('Who can get a code').fill('ana@example.com, @company.com ');
  await dialog.getByRole('radio', { name: '7 days' }).click();
  await expect(
    dialog.getByText(
      'Anyone at @company.com and ana@example.com can open app.example.com for 7 days after typing a code.',
    ),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Turn on email code' }).click();
  await expect(app.getByText('Email code, 2 people, 7 days')).toBeVisible();
  const apps = [...fake.accessApps.values()];
  expect(apps.map((one) => one.domain).sort()).toEqual([
    'app.example.com',
    'app.example.com/.well-known/acme-challenge',
  ]);

  // One more person, from the pencil.
  await app.getByRole('button', { name: 'Edit email code for app.example.com' }).click();
  const edit = page.getByRole('dialog', { name: 'Email code for app.example.com' });
  await edit.getByLabel('Who can get a code').fill('bo@example.com ');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(app.getByText('Email code, 3 people, 7 days')).toBeVisible();

  // A name without the proxy gets it, and then its switch works.
  const shop = page.getByRole('listitem', { name: 'shop.example.com' });
  await expect(shop.getByRole('switch')).toBeDisabled();
  await shop.getByRole('button', { name: 'Turn on proxy' }).click();
  await expect(shop.getByRole('switch')).toBeEnabled();
  expect(
    fake.zones.get(ZONE_ID)?.records.find((one) => one.name === 'shop.example.com')?.proxied,
  ).toBe(true);

  // And off again, once confirmed.
  await app.getByRole('switch', { name: 'Email code for app.example.com' }).click();
  await page
    .getByRole('dialog', { name: /Turn the email code off for app.example.com/ })
    .getByRole('button', { name: 'Turn off' })
    .click();
  await expect(app.getByText('Open to everyone')).toBeVisible();
  expect(fake.accessApps.size).toBe(0);
});

test('limits a path to listed addresses, changes it, pauses it and deletes it (E97)', async () => {
  if (!cloudflare) throw new Error('The Cloudflare fake did not start');
  const fake = cloudflare.fake;
  const here = '203.0.113.77';
  launched = await launchApp({
    settings: {},
    env: {
      RUNOVA_E2E_CLOUDFLARE_API: cloudflare.base,
      RUNOVA_E2E_IP_GEO: JSON.stringify({ ip: here, country: 'Testland', countryCode: 'TL' }),
    },
  });
  const { page } = launched;
  const rules = () => (fake.zones.get(ZONE_ID)?.ruleset?.rules ?? []) as Record<string, unknown>[];

  await page.getByRole('link', { name: 'Deploy' }).click();
  await page.getByRole('button', { name: 'Manage Cloudflare' }).click();
  await page.getByLabel('API token').fill(E2E_CLOUDFLARE_TOKEN);
  await page.getByRole('button', { name: 'Save and check' }).click();
  await expect(
    page.getByRole('button', { name: 'Choose a domain, example.com is open' }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Access' }).click();
  await expect(page.getByText('No IP limits yet')).toBeVisible();

  // /admin on app.example.com, for one address and this computer.
  await page.getByRole('button', { name: 'Add IP limit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Limit by IP address' });
  await dialog.getByRole('combobox', { name: 'Name' }).click();
  await page.getByRole('option', { name: 'app.example.com', exact: true }).click();
  await dialog.getByRole('radio', { name: 'One path' }).click();
  await dialog.getByLabel('Path').fill('/admin');
  await dialog.getByLabel('Addresses that get in').fill('198.51.100.7 ');
  await expect(dialog.getByText(`This computer (${here}) is not on the list`)).toBeVisible();
  await dialog.getByRole('button', { name: `Add this computer, ${here}` }).click();
  await expect(
    dialog.getByText(
      `Only 198.51.100.7 and ${here} can open app.example.com/admin and below. Everyone else gets Cloudflare's block page.`,
    ),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Add limit' }).click();

  const row = page.getByRole('listitem', { name: 'app.example.com/admin and below' });
  await expect(row.getByText('198.51.100.7')).toBeVisible();
  expect(rules()).toEqual([
    expect.objectContaining({
      action: 'block',
      enabled: true,
      expression: `(http.host eq "app.example.com" and starts_with(http.request.uri.path, "/admin") and not ip.src in {198.51.100.7 ${here}})`,
    }),
  ]);

  // One address fewer, from the pencil.
  await row
    .getByRole('button', { name: 'Edit IP limit for app.example.com/admin and below' })
    .click();
  const edit = page.getByRole('dialog', { name: 'Change the IP limit' });
  await edit.getByRole('button', { name: 'Remove 198.51.100.7' }).click();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByText('198.51.100.7')).toBeHidden();
  expect(rules()[0]?.expression).toContain(`not ip.src in {${here}})`);

  // Paused, then gone.
  await row.getByRole('switch', { name: 'IP limit for app.example.com/admin and below' }).click();
  await expect(row.getByText('Off')).toBeVisible();
  expect(rules()[0]?.enabled).toBe(false);
  await row
    .getByRole('button', { name: 'Delete IP limit for app.example.com/admin and below' })
    .click();
  await page
    .getByRole('dialog', { name: /Delete the IP limit/ })
    .getByRole('button', { name: 'Delete limit' })
    .click();
  await expect(page.getByText('No IP limits yet')).toBeVisible();
  expect(rules()).toEqual([]);
});
