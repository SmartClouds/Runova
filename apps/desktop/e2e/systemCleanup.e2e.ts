import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * Disk Cleanup through the real app. Every cache here is one the test built inside a sandbox
 * folder: the app is told to look only there, so nothing on the machine running the tests can be
 * seen or touched. The checks that matter are on disk: what was removed is gone, and what was
 * not is still there.
 */

let launched: LaunchedApp | undefined;
let sandbox: string | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  if (sandbox) rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  sandbox = undefined;
});

const KB = 1024;

function file(root: string, path: string, bytes: number): void {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, Buffer.alloc(bytes, 97));
}

/** A NuGet cache with three versions of one package, a Bun cache with two, nothing else. */
function seedCaches(): { sandbox: string; nuget: string; bun: string } {
  const folder = mkdtempSync(join(tmpdir(), 'runova-cleanup-'));
  const home = join(folder, 'home');
  const nuget = join(home, '.nuget', 'packages');
  for (const [version, size] of [
    ['1.0.0', 300],
    ['2.0.0', 500],
    ['3.0.0', 700],
  ] as const) {
    file(nuget, `acornima/${version}/acornima.${version}.nupkg`, size * KB);
    file(nuget, `acornima/${version}/.nupkg.metadata`, 100);
  }
  file(nuget, 'sass/1.1.52/sass.1.1.52.nupkg', 400 * KB);
  file(nuget, 'sass/1.1.52/.nupkg.metadata', 100);

  const bun = join(home, '.bun', 'install', 'cache');
  file(bun, 'react@19.2.8@@@1/package.json', 200 * KB);
  file(bun, 'react@19.3.1@@@1/package.json', 250 * KB);
  return { sandbox: folder, nuget, bun };
}

/** Disk Cleanup is a tab of Dev Tools, under Setup in the page's left menu. */
async function openDiskCleanup(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Dev Tools' }).click();
  await page
    .getByRole('navigation', { name: 'Tool categories' })
    .getByRole('button', { name: 'Disk Cleanup', exact: true })
    .click();
}

async function start(): Promise<{ page: Page; nuget: string; bun: string }> {
  const caches = seedCaches();
  sandbox = caches.sandbox;
  launched = await launchApp({ settings: {}, env: { RUNOVA_CLEANUP_SANDBOX: caches.sandbox } });
  const { page } = launched;
  await openDiskCleanup(page);
  return { page, nuget: caches.nuget, bun: caches.bun };
}

async function scan(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Find caches' }).click();
  await expect(page.getByRole('region', { name: 'NuGet cache' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Bun cache' })).toBeVisible();
}

// biome-ignore lint/correctness/noEmptyPattern: Playwright wants its fixtures destructured
test('scan, clean old versions, and only the old ones go', async ({}, info) => {
  const { page, nuget, bun } = await start();

  // It never scans on its own; it invites the first scan and says what it will and will not do.
  await expect(page.getByText('See what your tools are keeping')).toBeVisible();
  await expect(page.getByText(/nothing in your projects is touched/i)).toBeVisible();
  await page.screenshot({ path: info.outputPath('cleanup-first-run.png'), animations: 'disabled' });

  await scan(page);
  await expect(page.getByText('Can be freed')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Disk use' }).getByRole('img')).toBeVisible();
  await page.screenshot({ path: info.outputPath('cleanup-scanned.png') });

  const card = page.getByRole('region', { name: 'NuGet cache' });
  await card.getByRole('button', { name: 'Clean old versions in NuGet' }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove old versions from NuGet?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('frees up to');
  await expect(confirm).toContainText('deleted for good');
  await expect(confirm).toContainText('acornima');
  await confirm.screenshot({ path: info.outputPath('cleanup-confirm.png') });
  await confirm.getByRole('button', { name: /^Free / }).click();

  await expect(page.getByText(/Freed .* from NuGet\./)).toBeVisible();
  // The two older versions are gone, folder and all. The newest and the lone package stay.
  expect(existsSync(join(nuget, 'acornima', '1.0.0'))).toBe(false);
  expect(existsSync(join(nuget, 'acornima', '2.0.0'))).toBe(false);
  expect(existsSync(join(nuget, 'acornima', '3.0.0', 'acornima.3.0.0.nupkg'))).toBe(true);
  expect(existsSync(join(nuget, 'sass', '1.1.52', 'sass.1.1.52.nupkg'))).toBe(true);
  // Another cache is not touched by cleaning this one.
  expect(existsSync(join(bun, 'react@19.2.8@@@1', 'package.json'))).toBe(true);
  await page.screenshot({ path: info.outputPath('cleanup-done.png') });
});

test('cancelling the confirm removes nothing', async () => {
  const { page, nuget } = await start();
  await scan(page);
  await page
    .getByRole('region', { name: 'NuGet cache' })
    .getByRole('button', { name: 'Clean old versions in NuGet' })
    .click();
  const confirm = page.getByRole('dialog', { name: 'Remove old versions from NuGet?' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  expect(existsSync(join(nuget, 'acornima', '1.0.0'))).toBe(true);
  expect(existsSync(join(nuget, 'acornima', '2.0.0'))).toBe(true);
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright wants its fixtures destructured
test('review a cache, change what is picked, and only that is deleted', async ({}, info) => {
  const { page, nuget } = await start();
  await scan(page);
  await page
    .getByRole('region', { name: 'NuGet cache' })
    .getByRole('button', { name: 'Review NuGet' })
    .click();
  await expect(page.getByRole('heading', { level: 2, name: 'NuGet' })).toBeVisible();

  // Old versions start picked; open the package, keep 2.0.0 and also drop the lone package.
  await page.getByRole('button', { name: 'Show versions of acornima' }).click();
  await expect(page.getByRole('checkbox', { name: 'Select acornima 1.0.0' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select acornima 2.0.0' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select acornima 3.0.0' })).not.toBeChecked();
  await expect(page.getByText('Newest, kept')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select acornima 2.0.0' }).click();
  await page.getByRole('checkbox', { name: 'Select all versions of sass' }).click();
  await expect(page.getByText('2 items selected')).toBeVisible();
  await page.screenshot({ path: info.outputPath('cleanup-review.png'), animations: 'disabled' });

  await page.getByRole('button', { name: /^Delete \d/ }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete 2 items?' });
  await confirm.getByRole('button', { name: /^Delete \d/ }).click();
  await expect(page.getByText(/Freed .* from NuGet\./)).toBeVisible();

  expect(existsSync(join(nuget, 'acornima', '1.0.0'))).toBe(false);
  expect(existsSync(join(nuget, 'sass'))).toBe(false);
  expect(existsSync(join(nuget, 'acornima', '2.0.0', 'acornima.2.0.0.nupkg'))).toBe(true);
  expect(existsSync(join(nuget, 'acornima', '3.0.0', 'acornima.3.0.0.nupkg'))).toBe(true);
});

test('Clear all asks with the folder in the question and empties just that cache', async () => {
  const { page, nuget, bun } = await start();
  await scan(page);
  await page
    .getByRole('region', { name: 'Bun cache' })
    .getByRole('button', { name: 'Clear all of Bun' })
    .click();
  const confirm = page.getByRole('dialog', { name: 'Clear all of Bun?' });
  await expect(confirm).toContainText(bun);
  await confirm.getByRole('button', { name: /^Clear / }).click();
  await expect(page.getByText(/Freed .* from Bun\./)).toBeVisible();

  expect(existsSync(join(bun, 'react@19.2.8@@@1'))).toBe(false);
  expect(existsSync(join(bun, 'react@19.3.1@@@1'))).toBe(false);
  // The cache folder itself stays; only what was in it goes.
  expect(existsSync(bun)).toBe(true);
  expect(existsSync(join(nuget, 'acornima', '3.0.0', 'acornima.3.0.0.nupkg'))).toBe(true);
});

/** Just the part of the bridge these tests call, typed here since the page's own types are not. */
interface CleanupBridge {
  systemCleanup: {
    scan(requestId: string): Promise<{ scanId: string }>;
    clean(requestId: string, scanId: string, selection: unknown): Promise<unknown>;
  };
}

/** What a clean-up request says back, or "allowed" if it was not refused. */
async function ask(page: Page, scanId: string, selection: unknown): Promise<string> {
  return page.evaluate(
    async ({ scan, choice }) => {
      const api = (window as unknown as { runova: CleanupBridge }).runova.systemCleanup;
      try {
        await api.clean(`probe-${Math.random()}`, scan, choice);
        return 'allowed';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    { scan: scanId, choice: selection },
  );
}

test('requests a window should never make are refused, and nothing is removed', async () => {
  const { page, nuget } = await start();
  await scan(page);

  const scanId = await page.evaluate(async () => {
    const api = (window as unknown as { runova: CleanupBridge }).runova.systemCleanup;
    return (await api.scan(`probe-${Math.random()}`)).scanId;
  });
  const everything = { mode: 'everything', providerId: 'nuget' };

  // A scan that is not the current one.
  expect(await ask(page, 'some-old-scan', everything)).toMatch(/out of date/i);
  // A path smuggled in beside a valid choice, and one smuggled into a list of items.
  expect(await ask(page, scanId, { ...everything, path: 'C:\\Windows' })).toMatch(/not valid/i);
  expect(
    await ask(page, scanId, {
      mode: 'items',
      providerId: 'nuget',
      itemIds: ['a'],
      paths: ['C:\\'],
    }),
  ).toMatch(/not valid/i);
  // An item the scan never reported.
  expect(await ask(page, scanId, { mode: 'items', providerId: 'nuget', itemIds: ['zzz'] })).toMatch(
    /did not find/i,
  );
  // A cache that does not exist, and a way of keeping nothing.
  expect(await ask(page, scanId, { mode: 'everything', providerId: 'documents' })).toMatch(
    /not valid/i,
  );
  expect(await ask(page, scanId, { mode: 'old-versions', providerId: 'nuget', keep: 0 })).toMatch(
    /not valid/i,
  );

  expect(existsSync(join(nuget, 'acornima', '1.0.0', 'acornima.1.0.0.nupkg'))).toBe(true);
  expect(existsSync(join(nuget, 'sass', '1.1.52', 'sass.1.1.52.nupkg'))).toBe(true);
});

test('without a sandbox folder a test run is switched off and cannot see real caches', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;
  await openDiskCleanup(page);
  await expect(page.getByText('Disk Cleanup is switched off')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find caches' })).toHaveCount(0);

  const answer = await page.evaluate(async () => {
    const api = (window as unknown as { runova: CleanupBridge }).runova.systemCleanup;
    try {
      await api.scan(`probe-${Math.random()}`);
      return 'allowed';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(answer).toMatch(/switched off/i);
});
