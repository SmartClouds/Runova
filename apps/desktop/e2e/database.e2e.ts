import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * The Database section end to end (E44), against a real PostgreSQL in this computer's Docker:
 * the container shows as a card, one click connects with the password read from its environment,
 * and then a table is made, filled, read in the grid and queried.
 *
 * Needs Docker and the postgres:17-alpine image. RUNOVA_E2E_SCREENSHOTS names a folder to save
 * screenshots of each step into, for looking at the screens.
 */

const IMAGE = 'postgres:17-alpine';

function dockerHasImage(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return !!process.env.CI;
  }
}

let launched: LaunchedApp | undefined;
let container: string | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  if (container) {
    execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore', windowsHide: true });
    container = undefined;
  }
});

/** Types into the query editor once Monaco has loaded (it loads with the first query tab). */
async function typeQuery(text: string): Promise<void> {
  const page = launched?.page;
  if (!page) return;
  const lines = page.locator('.monaco-editor .view-lines');
  await expect(lines).toBeVisible();
  await lines.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(text);
}

async function shot(name: string): Promise<void> {
  const folder = process.env.RUNOVA_E2E_SCREENSHOTS;
  if (folder && launched) await launched.page.screenshot({ path: join(folder, `${name}.png`) });
}

test('connects to a Postgres container in one click and works with its tables', async () => {
  test.skip(!dockerHasImage(), `needs Docker with ${IMAGE}`);
  const name = `runova-e2e-pg-${randomBytes(3).toString('hex')}`;
  container = execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--name',
      name,
      '-p',
      '127.0.0.1::5432',
      '-e',
      'POSTGRES_PASSWORD=e2e-secret',
      '-e',
      'POSTGRES_DB=shop',
      IMAGE,
    ],
    { encoding: 'utf-8', windowsHide: true },
  ).trim();

  launched = await launchApp({});
  const { page } = launched;
  await page.getByRole('link', { name: 'Deploy' }).click();
  await page.getByRole('button', { name: 'Databases on this computer' }).click();

  const card = page.getByRole('group', { name });
  // Docker can be slow to list and inspect containers on a busy machine.
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByText('PostgreSQL')).toBeVisible();
  await shot('1-cards');

  // Postgres takes a moment to accept connections after the container starts.
  await expect(async () => {
    execFileSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'shop'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }).toPass({ timeout: 60_000 });
  await card.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 30_000 });
  // The password came from the container; nothing was asked.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/PostgreSQL 17/)).toBeVisible();

  await page.getByRole('button', { name: 'New query' }).click();
  await typeQuery(
    "CREATE TABLE orders (id serial PRIMARY KEY, customer text, total numeric(8,2)); INSERT INTO orders (customer, total) VALUES ('Ada', 12.5), ('Grace', 40), (NULL, 3);",
  );
  await page.keyboard.press('Control+Enter');
  await expect(page.getByText(/3 rows changed/)).toBeVisible();

  await page.getByRole('button', { name: 'Reload the tree' }).click();
  await page.getByRole('button', { name: 'Expand shop' }).click();
  await page.getByRole('button', { name: 'Expand public' }).click();
  await page.getByRole('treeitem', { name: 'orders' }).click();
  const grid = page.getByRole('table', { name: 'public.orders' });
  await expect(grid.getByText('Grace')).toBeVisible();
  await expect(grid.getByText('NULL')).toBeVisible();
  await expect(page.getByText('3 rows')).toBeVisible();
  await shot('2-grid');

  await page.getByRole('textbox', { name: 'Filter rows' }).fill('total > 10');
  await page.keyboard.press('Enter');
  await expect(grid.getByText('Ada')).toBeVisible();
  await expect(grid.getByRole('row')).toHaveCount(3);

  // A destructive query waits for a second yes.
  await page.getByRole('button', { name: 'New query' }).click();
  await typeQuery('DELETE FROM orders');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByText(/deletes data or structure/)).toBeVisible();
  await shot('3-confirm');
  await page.getByRole('button', { name: 'Run anyway' }).click();
  await expect(page.getByText(/3 rows changed/)).toBeVisible();

  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(card).toBeVisible();
});
