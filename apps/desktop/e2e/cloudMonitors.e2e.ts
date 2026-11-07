import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type FakeAccountServer, startFakeAccountServer } from './fakeAccountServer';

/**
 * Online monitors (E56) against a fake website API: a monitor added with "Runova Cloud" goes to
 * the server with its key (after the person agreed), shows the Cloud badge, shows what the nodes
 * found, and pauses on the server. The fake has no notifications hub, so the result is read with
 * Refresh; the live push is covered by the main process tests.
 */

let server: FakeAccountServer;
let launched: LaunchedApp;

test.afterEach(async () => {
  await launched?.close();
  await server?.close();
});

const PROJECT = 'Cloud e2e';
const CONSENT = "Runova Cloud keeps this monitor's address and access key so it can check it.";

async function signIn(app: LaunchedApp) {
  const { app: electron, page } = app;
  // Nothing opens a real browser: main follows the sign-in page itself, which the fake approves.
  await electron.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });
  await page.getByRole('link', { name: 'Account' }).click();
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(page.getByRole('heading', { name: 'Sam Rivera' })).toBeVisible({ timeout: 30_000 });
}

test('a monitor turned online goes to Runova Cloud with its key, shows what it found and pauses there', async () => {
  test.setTimeout(240_000);
  server = await startFakeAccountServer();
  launched = await launchApp({ settings: {}, env: { RUNOVA_ACCOUNT_API_URL: server.base } });
  const { page } = launched;

  await page.evaluate(
    async ({ folderPath, name }) => {
      await window.runova.projects.create({
        name,
        folderPath,
        description: '',
        tags: [],
        agentType: 'claude-code',
        notes: '',
        runCommands: [],
      } as never);
    },
    { folderPath: launched.projectDir, name: PROJECT },
  );
  await signIn(launched);
  await page.evaluate(() => {
    location.hash = '#/monitoring';
  });

  await page.getByRole('button', { name: 'Add a target' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Project', exact: true }).click();
  await page.getByRole('option', { name: PROJECT }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('API');
  // A name that never resolves, so nothing on the internet is called while it is still local.
  await dialog
    .getByLabel('Endpoint URL', { exact: true })
    .fill('https://api.runova-e2e.invalid/health');

  await dialog.getByRole('button', { name: 'Runova Cloud' }).click();
  await expect(dialog.getByText('Go · 0 of 10 online')).toBeVisible({ timeout: 20_000 });
  // Go checks every 5 minutes or slower: faster is not offered, and the choice moved up.
  await expect(dialog.getByRole('button', { name: '5 min', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(dialog.getByRole('group', { name: 'Check every' })).not.toContainText('1 min');

  // Nothing leaves without consent.
  await dialog.getByRole('button', { name: 'Add target' }).click();
  await expect(
    dialog.getByText('Agree to send the address and key to Runova Cloud first.'),
  ).toBeVisible();
  expect(server.cloudMonitors()).toHaveLength(0);

  await dialog.getByRole('checkbox', { name: CONSENT }).click();
  await dialog.getByRole('button', { name: 'Add target' }).click();

  await expect(page.getByText('Save this key now')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Show key' }).click();
  const key = (
    await page
      .getByRole('dialog')
      .locator('div.space-y-1')
      .filter({ has: page.getByText('Key', { exact: true }) })
      .first()
      .locator('code')
      .innerText()
  ).trim();
  await page.getByRole('button', { name: 'I saved it' }).click();

  await expect.poll(() => server.cloudMonitors().length, { timeout: 20_000 }).toBe(1);
  const [online] = server.cloudMonitors();
  expect(online).toMatchObject({
    name: 'API',
    projectName: PROJECT,
    url: 'https://api.runova-e2e.invalid/health',
    intervalSec: 300,
    authMode: 'bearer',
    secret: key,
    notifyInApp: true,
  });
  // The run mode is saved (and synced), so no computer checks it any more.
  const saved = JSON.parse(
    readFileSync(join(launched.userDataDir, 'data', 'health-targets.json'), 'utf-8'),
  );
  expect(saved[0]).toMatchObject({
    runMode: 'cloud',
    cloudMonitorId: online.id,
    id: online.itemId,
  });

  const card = page.getByRole('article', { name: 'API' });
  await expect(card.getByText('Cloud', { exact: true })).toBeVisible({ timeout: 20_000 });

  // The nodes find it down; the panel reads it from the server.
  server.setCloudResult(online.id, {
    state: 'unreachable',
    latencyMs: null,
    region: 'eu-central',
    problem: 'Connection refused',
  });
  await page.getByRole('button', { name: 'Open API' }).click();
  const panel = page.getByRole('dialog');
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(panel.getByText('Runova Cloud, eu-central')).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText('Connection refused').first()).toBeVisible();

  // Paused here, paused there.
  await panel.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect
    .poll(
      () =>
        server.cloudCalls().some((call) => call.method === 'PATCH' && call.body?.paused === true),
      { timeout: 20_000 },
    )
    .toBe(true);
});
