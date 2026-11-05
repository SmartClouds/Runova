import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createProject, type LaunchedApp, launchApp } from './app';

/**
 * Project clean-up through the real app: the Cleanup section scans a project folder, the person
 * picks, confirms and deletes, and the files on disk agree. The last test sends requests a window
 * should never make straight to the main process, since the checks there are what keeps source
 * and `.env` files safe, whatever the UI does.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

const KB = 1024;

function file(root: string, path: string, bytes: number): void {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, Buffer.alloc(bytes, 97));
}

/** A small pnpm project: source and secrets to keep, and three kinds of weight to clear. */
function seedProject(root: string): void {
  file(root, 'package.json', 20);
  file(root, 'pnpm-lock.yaml', 20);
  file(root, 'src/index.ts', 300);
  file(root, '.env', 40);
  file(root, 'node_modules/dep-a/index.js', 1024 * KB);
  file(root, 'node_modules/dep-b/index.js', 1024 * KB);
  file(root, 'node_modules/dep-c/index.js', 1024 * KB);
  file(root, 'dist/main.js', 1024 * KB);
  file(root, 'dist/main.js.map', 512 * KB);
  file(root, '.turbo/run.log', 200 * KB);
}

async function openCleanup(current: LaunchedApp): Promise<string> {
  const id = await createProject(current);
  await current.page.evaluate((projectId) => {
    location.hash = `#/projects/${projectId}?tab=cleanup`;
  }, id);
  await current.page.reload();
  return id;
}

// biome-ignore lint/correctness/noEmptyPattern: Playwright wants its fixtures destructured
test('scan a project, pick what to delete, confirm, and only that goes', async ({}, info) => {
  launched = await launchApp({ settings: {} });
  const { page, projectDir } = launched;
  seedProject(projectDir);
  await openCleanup(launched);

  // It scans on its own and says what it found.
  await expect(page.getByText('Can be freed')).toBeVisible();
  for (const name of ['Build output', 'Caches', 'Dependencies']) {
    await expect(page.getByRole('region', { name })).toBeVisible();
  }
  await expect(page.getByRole('region', { name: 'Disk use' }).getByRole('img')).toBeVisible();
  await expect(page.getByText(/never touches your source/i)).toBeVisible();

  // What comes back by itself is already picked; the dependencies are not.
  await expect(page.getByRole('checkbox', { name: 'Select dist' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select .turbo' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select node_modules' })).not.toBeChecked();
  await expect(page.getByText('2 items selected')).toBeVisible();
  await page.screenshot({ path: info.outputPath('cleanup-ready.png') });

  await page.getByRole('checkbox', { name: 'Select all in Dependencies' }).click();
  await expect(page.getByText('3 items selected')).toBeVisible();
  await page.getByRole('button', { name: /^Delete \d/ }).click();

  const confirm = page.getByRole('dialog', { name: 'Delete 3 items?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('pnpm install');
  await expect(confirm).toContainText('node_modules');
  await expect(confirm).toContainText('not moved to the Recycle Bin');
  await confirm.screenshot({ path: info.outputPath('cleanup-confirm.png') });
  await confirm.getByRole('button', { name: /^Delete \d/ }).click();

  await expect(page.getByText('Nothing to clean up')).toBeVisible();
  expect(existsSync(join(projectDir, 'node_modules'))).toBe(false);
  expect(existsSync(join(projectDir, 'dist'))).toBe(false);
  expect(existsSync(join(projectDir, '.turbo'))).toBe(false);
  // What the project is made of is still there.
  expect(existsSync(join(projectDir, 'src', 'index.ts'))).toBe(true);
  expect(existsSync(join(projectDir, '.env'))).toBe(true);
  expect(existsSync(join(projectDir, 'package.json'))).toBe(true);
  await page.screenshot({ path: info.outputPath('cleanup-done.png') });
});

test('cancelling the confirm deletes nothing', async () => {
  launched = await launchApp({ settings: {} });
  const { page, projectDir } = launched;
  seedProject(projectDir);
  await openCleanup(launched);

  await expect(page.getByText('Can be freed')).toBeVisible();
  await page.getByRole('button', { name: /^Delete \d/ }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete 2 items?' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();

  expect(existsSync(join(projectDir, 'dist', 'main.js'))).toBe(true);
  expect(existsSync(join(projectDir, '.turbo', 'run.log'))).toBe(true);
  await expect(page.getByText('2 items selected')).toBeVisible();
});

test('the Projects page shows each size once the projects are checked, and the chip opens Cleanup', async () => {
  launched = await launchApp({ settings: {} });
  const { page, projectDir } = launched;
  seedProject(projectDir);
  const id = await createProject(launched);
  await page.evaluate(() => {
    location.hash = '#/projects';
  });
  await page.reload();

  await expect(
    page.getByRole('button', { name: /check how much space this project uses/i }),
  ).toBeVisible();
  await page.getByRole('button', { name: /check sizes/i }).click();

  const chip = page.getByRole('button', {
    name: /this project uses .* can be freed\. Open Cleanup\./i,
  });
  await expect(chip).toBeVisible();
  await expect(page.getByText(/to free/).first()).toBeVisible();
  await chip.click();
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(`#/projects/${id}?tab=cleanup`);
  await expect(page.getByText('Can be freed')).toBeVisible();
});

test('the main process refuses requests for anything it would not have offered', async () => {
  launched = await launchApp({ settings: {} });
  const { page, projectDir } = launched;
  seedProject(projectDir);
  const id = await createProject(launched);

  const ask = (items: unknown[]) =>
    page.evaluate(
      async ([projectId, list]) => {
        const api = (
          window as unknown as {
            runova: {
              projectCleanup: {
                scan(project: string, request: string): Promise<unknown>;
                remove(
                  project: string,
                  request: string,
                  items: unknown[],
                ): Promise<{ removed: string[]; failed: { key: string; error: string }[] }>;
              };
            };
          }
        ).runova.projectCleanup;
        await api.scan(projectId as string, 'scan-1');
        return api.remove(projectId as string, 'remove-1', list as unknown[]);
      },
      [id, items] as const,
    );

  const result = await ask([
    { kind: 'folder', locationId: 'main', relPath: 'src' },
    { kind: 'folder', locationId: 'main', relPath: '.env' },
    { kind: 'folder', locationId: 'main', relPath: '../outside' },
    { kind: 'folder', locationId: 'main', relPath: 'node_modules/../src' },
    { kind: 'folder', locationId: 'nowhere', relPath: 'dist' },
  ]);
  expect(result.removed).toEqual([]);
  expect(result.failed).toHaveLength(5);
  expect(existsSync(join(projectDir, 'src', 'index.ts'))).toBe(true);
  expect(existsSync(join(projectDir, '.env'))).toBe(true);
  expect(existsSync(join(projectDir, 'dist', 'main.js'))).toBe(true);

  // A request that is not even the right shape never reaches the service.
  await expect(ask([{ kind: 'folder', relPath: '/etc' }])).rejects.toThrow();
  await expect(ask([])).rejects.toThrow();
});
