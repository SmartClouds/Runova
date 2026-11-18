import { expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';
import { addSites, DEV_PASSWORD, devPost, openSection, setStatistics, signIn } from './devTraffic';
import { type FakeTelegramApi, startFakeTelegramApi } from './fakeTelegramApi';

/**
 * Attack detection and blocking (E110) against the DevHost: Telegram alerts set up with a fake Bot
 * API, statistics (and with them detection) turned on, then the DevHost writes a scan from one
 * address into a site's log. The core opens the alert at once: Telegram gets the message, the app's
 * inbox gets an entry that opens the site's Security view, the Security card lists the address,
 * and an Admin blocks it after reading what that does and lets it back in.
 */

test.skip(!dotnetAvailable(), 'needs the .NET SDK to build the server core DevHost');

const TOKEN = '7700000002:AAHe2eQx9v2Lw8YtPz5rNc4mBq7sDf1gHjF';
const CHAT = '-1001234567891';
const BLOG = 'blog.example.com';
const BLOG_ID = 'blog-example-com';
const ATTACKER = '198.51.100.23';

let devHost: DevHost | undefined;
let telegram: FakeTelegramApi | undefined;
let launched: LaunchedApp | undefined;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  telegram = await startFakeTelegramApi();
  devHost = await startDevHost({
    args: [`--Core:Telegram:ApiBase=http://127.0.0.1:${telegram.port}/`],
  });
});

test.afterAll(async () => {
  devHost?.stop();
  await telegram?.stop();
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** Answers the step-up dialog when the core asks for one, or returns once `done` is on screen. */
async function stepUpIfAsked(page: Page, done: Locator): Promise<void> {
  const proof = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(proof.or(done)).toBeVisible({ timeout: 30_000 });
  if (await proof.isVisible()) {
    await proof.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
    await proof.getByRole('button', { name: 'Confirm' }).click();
  }
}

interface InboxEntry {
  title: string;
  route?: string;
}

function inbox(page: Page): Promise<InboxEntry[]> {
  return page.evaluate(() =>
    (
      window as unknown as { runova: { appNotifications: { list(): Promise<InboxEntry[]> } } }
    ).runova.appNotifications.list(),
  );
}

test('a scan reaches Telegram and the inbox, and the address is blocked and let back in', async () => {
  test.setTimeout(300_000);
  if (!devHost || !telegram) throw new Error('The DevHost or the fake Telegram did not start');
  launched = await launchApp({
    settings: {},
    env: { RUNOVA_DEPLOY_DEV_CORE: String(devHost.port) },
  });
  const { page } = launched;
  await signIn(page);

  // Telegram alerts, every kind on: the four attack kinds are among them.
  await openSection(page, 'Notifications');
  await expect(page.getByRole('switch', { name: 'Website scanned' })).toBeChecked({
    timeout: 30_000,
  });
  await page.getByLabel('Server name', { exact: true }).fill('e2e-box');
  await page.getByLabel('Bot token', { exact: true }).fill(TOKEN);
  await page.getByLabel('Chat ID', { exact: true }).fill(CHAT);
  await page.getByRole('button', { name: 'Turn on Telegram alerts' }).click();
  const waiting = page.getByText('On, nothing sent yet', { exact: true });
  await stepUpIfAsked(page, waiting);
  await expect(waiting).toBeVisible({ timeout: 30_000 });

  // A site, and statistics on, which turns detection on with them.
  await addSites(page, [BLOG]);
  await openSection(page, 'Traffic');
  await setStatistics(page, true);
  await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible({ timeout: 30_000 });

  // A scan from one address, read by the core at once.
  await devPost(devHost.port, '/dev/sites/attack', {
    siteId: BLOG_ID,
    kind: 'scan',
    address: ATTACKER,
  });

  // Telegram gets it from the core alone.
  await expect
    .poll(() => telegram?.messages.some((message) => message.text.includes(ATTACKER)), {
      timeout: 60_000,
    })
    .toBe(true);
  const sent = telegram.messages.find((message) => message.text.includes(ATTACKER));
  expect(sent?.chatId).toBe(CHAT);
  expect(sent?.text).toMatch(/A website is being scanned/);

  // The inbox names the site, and the entry opens its Security view.
  await expect
    .poll(
      async () => (await inbox(page)).find((entry) => entry.title.startsWith('Scan on'))?.title,
      {
        timeout: 60_000,
      },
    )
    .toMatch(new RegExp(`^Scan on ${BLOG_ID} \\(`));
  const entry = (await inbox(page)).find((item) => item.title.startsWith('Scan on'));
  expect(entry?.route).toContain(`view=traffic&traffic=${BLOG_ID}&panel=security`);
  await page.evaluate((route) => {
    window.location.hash = `#${route}`;
  }, entry?.route ?? '');

  // The Security card lists the address with what it tried.
  const attacks = page.getByRole('table', { name: 'Recent attacks' });
  const row = attacks.getByRole('row').filter({ hasText: ATTACKER });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText('Scans');

  // Block: the preview says what happens, then nginx refuses the address.
  await row.getByRole('button', { name: `Block ${ATTACKER}` }).click();
  const confirm = page.getByRole('dialog', { name: `Block ${ATTACKER}?` });
  await expect(confirm).toContainText('on every site on this server');
  await confirm.getByRole('button', { name: 'Block', exact: true }).click();
  const blocked = page.getByRole('list', { name: 'Blocked addresses' });
  await expect(blocked.getByText(ATTACKER, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText('Blocked', { timeout: 30_000 });

  // Unblock asks too, then the list is empty again.
  await blocked.getByRole('button', { name: `Unblock ${ATTACKER}` }).click();
  const letIn = page.getByRole('dialog', { name: `Let ${ATTACKER} back in?` });
  await letIn.getByRole('button', { name: 'Unblock', exact: true }).click();
  await expect(page.getByText('No address is blocked.')).toBeVisible({ timeout: 30_000 });
});
