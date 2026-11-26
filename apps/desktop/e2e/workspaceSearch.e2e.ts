import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp, openWorkspace } from './app';

/**
 * The workspace search end to end: Ctrl+P opens it on the workspace, the bundled ripgrep finds
 * text in the project, the symbol index finds a declaration, and Enter opens the file at its
 * line. Ctrl+P anywhere else still goes to Projects.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

function searchBox(page: Page): Locator {
  return page.getByRole('combobox', { name: /search files, types, members and text/i });
}

/**
 * The workspace binds its keys in an effect, so an early press is retried until it lands. The key
 * is the platform's own: on macOS Ctrl+P belongs to the editor (it moves the cursor up a line, and
 * the editor keeps it), so a person there presses Cmd+P.
 */
async function openSearch(page: Page): Promise<Locator> {
  const input = searchBox(page);
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+P');
    await expect(input).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  return input;
}

test('finds text and declarations, and opens the result at its line', async () => {
  launched = await launchApp({ settings: {} });
  const { page, projectDir } = launched;
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(
    join(projectDir, 'src', 'store.ts'),
    'export class OrderStore {\n  load() {\n    return "needle in the store";\n  }\n}\n',
  );
  writeFileSync(join(projectDir, 'README.md'), '# Demo\n');
  await openWorkspace(launched);
  await expect(page.getByText('Pick a project to work on')).toBeHidden();

  const input = await openSearch(page);

  await input.fill('x:needle in');
  const line = page.getByRole('option').filter({ hasText: 'needle in the store' });
  await expect(line).toBeVisible();
  await expect(page.getByRole('region', { name: 'Preview' })).toContainText('Ln 3, Ch');

  await input.fill('t:orderstore');
  const type = page.getByRole('option').filter({ hasText: 'OrderStore' });
  await expect(type).toBeVisible();
  await expect(type).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Enter');
  await expect(input).toBeHidden();
  await expect(page.getByText('store.ts').first()).toBeVisible();
  // The editor takes focus once the file has loaded and the declaration is revealed. On a busy
  // machine that comes well after the tab shows, and if it lands while the search is open again
  // it pulls focus out of the box, so wait for it as a person would see the cursor in the file.
  await expect(page.locator('.monaco-editor.focused')).toBeVisible();

  // The next opening starts with the file that was just opened.
  await openSearch(page);
  await input.fill('');
  await expect(page.getByText('Recent files')).toBeVisible();
  await expect(page.getByRole('option').first()).toContainText('store.ts');
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();
});

test('Ctrl+P away from the workspace still goes to Projects', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;
  await page.evaluate(() => {
    location.hash = '#/settings';
  });
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(async () => {
    await page.keyboard.press('Control+P');
    await expect(page).toHaveURL(/#\/projects/, { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
});
