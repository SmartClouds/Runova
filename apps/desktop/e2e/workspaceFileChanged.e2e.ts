import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp, openWorkspace } from './app';

/**
 * A file open in the editor follows changes made outside the app, the way an agent edits files:
 * with no unsaved edits it reloads and says so, and with unsaved edits it keeps them and asks.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** The workspace binds its keys in an effect, so an early press is retried until it lands. */
async function openSearch(page: Page): Promise<Locator> {
  const input = page.getByRole('combobox', { name: /search files, types, members and text/i });
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+P');
    await expect(input).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  return input;
}

test('an open file follows changes on disk, and asks first when it has unsaved edits', async () => {
  launched = await launchApp({ settings: {} });
  const { page, projectDir } = launched;
  const file = join(projectDir, 'config.txt');
  writeFileSync(file, 'API_URL=first-value\n');
  await openWorkspace(launched);
  await expect(page.getByText('Pick a project to work on')).toBeHidden();

  const input = await openSearch(page);
  await input.fill('x:first-value');
  await expect(page.getByRole('option').filter({ hasText: 'first-value' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(input).toBeHidden();
  const lines = page.locator('.monaco-editor .view-lines').first();
  await expect(lines).toContainText('API_URL=first-value', { timeout: 30_000 });

  // Changed outside the app with nothing unsaved: the editor follows and says so.
  writeFileSync(file, 'API_URL=second-value\n');
  await expect(lines).toContainText('API_URL=second-value', { timeout: 15_000 });
  await expect(
    page.getByRole('status').filter({ hasText: 'changed on disk and was reloaded' }),
  ).toBeVisible();

  // Changed again under unsaved edits: the edits stay until a choice is made.
  await lines.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('MINE=1');
  await expect(lines).toContainText('MINE=1');
  writeFileSync(file, 'API_URL=third-value\n');
  const alert = page
    .getByRole('alert')
    .filter({ hasText: 'changed on disk. Your edits are not saved.' });
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(lines).toContainText('MINE=1');

  await alert.getByRole('button', { name: 'Show new version' }).click();
  await expect(lines).toContainText('API_URL=third-value');
  await expect(lines).not.toContainText('MINE=1');
  await expect(alert).toBeHidden();
});
