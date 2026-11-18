import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type FakeAccountServer, startFakeAccountServer } from './fakeAccountServer';

/**
 * Runova accounts and cloud sync (E48), with two computers on one account against a fake website
 * API. AC1: a project made on one computer appears on the other without a folder, and picking a
 * folder there leaves the first computer's folder alone. AC2 and AC3: a server's password does not
 * leave the computer until a key is set, after which the server holds only ciphertext, and the
 * second computer reads it only after typing the passphrase.
 */

let server: FakeAccountServer;
let first: LaunchedApp;
let second: LaunchedApp;

test.afterEach(async () => {
  await first?.close();
  await second?.close();
  await server?.close();
});

async function signIn(launched: LaunchedApp) {
  const { app, page } = launched;
  // Nothing opens a real browser: main follows the sign-in page itself, which the fake approves.
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });
  await page.getByRole('link', { name: 'Account' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to sync this computer' })).toBeVisible();
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(page.getByRole('heading', { name: 'Sam Rivera' })).toBeVisible({ timeout: 30_000 });
}

const syncNow = (launched: LaunchedApp) =>
  launched.page.evaluate(() => window.runova.sync.syncNow());

/**
 * Shows the recovery phrase Runova made, reads its words off the card, and answers the three-word
 * check. Returns the phrase, so a second computer can type it.
 */
async function savePhraseAndPassCheck(page: Page): Promise<string> {
  await page.getByRole('button', { name: /Show the words/ }).click();
  const words = await page
    .getByRole('list', { name: 'Recovery phrase' })
    .getByRole('listitem')
    .locator('span.font-mono')
    .allTextContents();
  await page.getByRole('button', { name: /I saved it/ }).click();
  for (let i = 0; i < 3; i++) {
    const asked = await page.getByText(/^Which is word \d+\?$/).textContent();
    const place = Number(asked?.match(/\d+/)?.[0]);
    await page.getByRole('button', { name: words[place - 1], exact: true }).click();
  }
  await expect(page.getByText('Your phrase is checked')).toBeVisible();
  return words.join(' ');
}

test('two computers on one account share a project, and each keeps its own folder', async () => {
  test.setTimeout(240_000);
  server = await startFakeAccountServer();
  const env = { RUNOVA_ACCOUNT_API_URL: server.base };
  first = await launchApp({ settings: {}, env });
  second = await launchApp({ settings: {}, env });
  await signIn(first);
  await signIn(second);
  expect(server.sessions()).toHaveLength(2);

  const windowsFolder = join(first.root, 'shop');
  mkdirSync(windowsFolder, { recursive: true });
  await first.page.evaluate(
    (folderPath) =>
      window.runova.projects.create({
        name: 'Shop',
        folderPath,
        description: 'The storefront',
        tags: ['web'],
        agentType: 'claude',
        notes: '',
        runCommands: [],
      }),
    windowsFolder,
  );
  await syncNow(first);
  expect(JSON.stringify(server.records())).not.toContain(windowsFolder.replaceAll('\\', '\\\\'));
  await syncNow(second);

  const arrived = await second.page.evaluate(() => window.runova.projects.list());
  expect(arrived).toEqual([
    expect.objectContaining({ name: 'Shop', description: 'The storefront', folderPath: '' }),
  ]);
  await second.page.getByRole('link', { name: 'Projects' }).click();
  await expect(second.page.getByRole('button', { name: /Choose folder/ })).toBeVisible();

  const macFolder = join(second.root, 'elsewhere', 'shop');
  mkdirSync(macFolder, { recursive: true });
  const id = (arrived[0] as { id: string }).id;
  await second.page.evaluate(
    ([projectId, folderPath]) => window.runova.projects.update(projectId, { folderPath }),
    [id, macFolder] as const,
  );
  await syncNow(second);
  await syncNow(first);

  const onFirst = await first.page.evaluate(() => window.runova.projects.list());
  const onSecond = await second.page.evaluate(() => window.runova.projects.list());
  expect(onFirst[0]?.folderPath).toBe(windowsFolder);
  expect(onSecond[0]?.folderPath).toBe(macFolder);
});

test('a server password leaves only sealed, and opens on the other computer after the passphrase', async () => {
  test.setTimeout(240_000);
  server = await startFakeAccountServer();
  const env = { RUNOVA_ACCOUNT_API_URL: server.base };
  first = await launchApp({ settings: {}, env });
  second = await launchApp({ settings: {}, env });
  await signIn(first);
  await signIn(second);

  await first.page.evaluate(() =>
    window.runova.ssh.saveServer({
      nickname: 'Production',
      host: 'prod.example.test',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      secret: 'the-real-password',
    }),
  );
  await syncNow(first);
  expect(JSON.stringify(server.records())).toContain('prod.example.test');
  expect(JSON.stringify(server.records())).not.toContain('the-real-password');

  // Set the key through the screen, the way a person does: a recovery phrase Runova makes (E107),
  // shown, checked, then used.
  await first.page.getByRole('button', { name: 'Sync and encryption' }).click();
  await first.page.getByRole('button', { name: /Set a key/ }).click();
  const phrase = await savePhraseAndPassCheck(first.page);
  expect(phrase.split(' ')).toHaveLength(24);
  await first.page.getByRole('button', { name: 'Set the key' }).click();
  await expect(first.page.getByText('Save your recovery key')).toBeVisible({ timeout: 60_000 });
  await first.page.getByLabel(/I saved my recovery key/).check();
  await first.page.getByRole('button', { name: 'Done' }).click();
  await syncNow(first);

  const stored = server.records().find((r) => r.collection === 'ssh-servers');
  expect(stored?.encryption).toBe('e2ee');
  expect(stored?.payload).not.toContain('the-real-password');

  await syncNow(second);
  await second.page.getByRole('button', { name: 'Sync and encryption' }).click();
  await expect(second.page.getByText('Locked on this computer')).toBeVisible();
  await second.page.getByRole('button', { name: /Unlock here/ }).click();
  await second.page.getByLabel('Passphrase').fill('wrong but long enough');
  await second.page.getByRole('button', { name: 'Unlock' }).click();
  await expect(second.page.getByRole('alert')).toContainText('not right');
  // The phrase goes in the word boxes, here typed in capitals, and still opens the key.
  await second.page.getByRole('button', { name: 'My passphrase is a recovery phrase' }).click();
  await second.page
    .getByRole('textbox', { name: 'Word 1', exact: true })
    .fill(phrase.toUpperCase());
  await expect(second.page.getByText('The words check out')).toBeVisible();
  await second.page.getByRole('button', { name: 'Unlock' }).click();
  await expect(second.page.getByText('Secrets sealed')).toBeVisible({ timeout: 60_000 });
  await syncNow(second);

  const servers = await second.page.evaluate(() => window.runova.ssh.listServers());
  expect(servers).toEqual([
    expect.objectContaining({ host: 'prod.example.test', hasSecret: true }),
  ]);
});
