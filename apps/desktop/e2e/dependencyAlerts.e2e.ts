import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type FakeAccountServer, startFakeAccountServer } from './fakeAccountServer';

/**
 * Dependency alerts (E51) against a fake website API. Signing in sends each project's package
 * list up (names and versions only); what the server's daily check found shows as a badge on
 * Projects, a chip on the project's card and a message in the inbox; the Settings card turns it
 * off on the account, and the badges go.
 */

let server: FakeAccountServer;
let launched: LaunchedApp;

test.afterEach(async () => {
  await launched?.close();
  await server?.close();
});

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

test('a signed-in app sends its packages up and shows what the daily check found', async () => {
  test.setTimeout(180_000);
  server = await startFakeAccountServer();
  launched = await launchApp({ settings: {}, env: { RUNOVA_ACCOUNT_API_URL: server.base } });
  const { page } = launched;

  const folder = join(launched.root, 'shop');
  mkdirSync(join(folder, 'node_modules', 'lodash'), { recursive: true });
  writeFileSync(
    join(folder, 'package.json'),
    JSON.stringify({ name: 'shop', dependencies: { lodash: '^4.17.0' } }),
  );
  writeFileSync(
    join(folder, 'node_modules', 'lodash', 'package.json'),
    JSON.stringify({ version: '4.17.20' }),
  );
  const created = await page.evaluate(
    (folderPath) =>
      window.runova.projects.create({
        name: 'Shop',
        folderPath,
        description: '',
        tags: [],
        agentType: 'claude',
        notes: '',
        runCommands: [],
      }),
    folder,
  );
  const projectId = (created as { id: string }).id;
  server.setFindings([
    {
      inventoryId: 7,
      scopeId: 1,
      itemId: projectId,
      projectName: 'Shop',
      lastCheckedAt: '2026-11-06T09:00:00.000Z',
      total: 2,
      worstSeverity: 'high',
      counts: { security: 1, deprecated: 0, major: 1, minor: 0, patch: 0 },
      findings: [],
    },
  ]);
  server.setNotifications([
    {
      id: 1,
      kind: 'dependency-updates',
      title: '2 package updates for Shop',
      body: 'lodash 4.17.20 to 4.17.21: high security issue',
      severity: 'high',
      scopeId: 1,
      itemId: projectId,
      inventoryId: 7,
      createdAt: '2026-11-06T09:00:00.000Z',
      readAt: null,
    },
  ]);

  await signIn(launched);

  await expect
    .poll(() => server.inventories(), { timeout: 30_000 })
    .toEqual([
      {
        scopeId: 1,
        itemId: projectId,
        body: {
          projectName: 'Shop',
          packages: [{ ecosystem: 'npm', name: 'lodash', version: '4.17.20', dev: false }],
        },
      },
    ]);
  // Names and versions only: no folder of this computer goes up.
  expect(JSON.stringify(server.inventories())).not.toContain('node_modules');

  await expect(
    page.getByRole('link', { name: /Projects.*1 project with package updates/ }),
  ).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.runova.appNotifications.list())).map((n) => n.id),
      { timeout: 30_000 },
    )
    .toContain('dependency:1');

  await page.getByRole('link', { name: /Projects/ }).click();
  const chip = page.getByRole('button', {
    name: '2 package updates in this project, 1 of them a high security issue. Open Packages.',
  });
  await expect(chip).toBeVisible();
  await chip.click();
  // The tab draws its toolbar once the package scan (npm outdated) is done, which a busy machine
  // can take a while over.
  await expect(page.getByRole('switch', { name: 'Package alerts for this project' })).toBeChecked({
    timeout: 60_000,
  });

  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=notifications';
  });
  const toggle = page.getByRole('switch', { name: 'Package update alerts' });
  // Settings is a large page loaded on first use, and the card waits for the account and its settings.
  await expect(toggle).toBeChecked({ timeout: 30_000 });
  await toggle.click();

  await expect.poll(() => server.alertSettings().enabled).toBe(false);
  await expect(page.getByRole('link', { name: /Projects/ })).not.toContainText('1');
});
