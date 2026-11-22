import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createProject, type LaunchedApp, launchApp } from './app';

/**
 * An env file saved in the Environments tab, linked to the real `.env.prod` in the project folder.
 * Linking takes the file's contents, a change made to the file in another editor shows up in the
 * tab by itself as a new version, and a save in Runova writes the file back.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

interface SavedFile {
  environmentId: string;
  fileId: string;
}

/** An environment with one saved `.env.prod`, made through the same bridge the tab uses. */
async function seedEnvironment(current: LaunchedApp, projectId: string): Promise<SavedFile> {
  return current.page.evaluate(async (id) => {
    const api = (
      window as unknown as {
        runova: {
          environments: {
            save(input: unknown): Promise<{ id: string }>;
            saveFile(input: unknown): Promise<{ files: { id: string }[] }>;
          };
        };
      }
    ).runova.environments;
    const environment = await api.save({ projectId: id, name: 'Production', kind: 'production' });
    const saved = await api.saveFile({
      environmentId: environment.id,
      fileName: '.env.prod',
      content: 'API_URL=https://old.example\n',
    });
    return { environmentId: environment.id, fileId: saved.files[0].id };
  }, projectId);
}

// biome-ignore lint/correctness/noEmptyPattern: Playwright wants its fixtures destructured
test('a linked env file follows its project file both ways', async ({}) => {
  launched = await launchApp({ settings: {} });
  const { page, projectDir } = launched;
  const onDisk = join(projectDir, '.env.prod');
  writeFileSync(onDisk, 'API_URL=https://one.example\n', 'utf-8');
  const projectId = await createProject(launched);
  const saved = await seedEnvironment(launched, projectId);

  await page.evaluate((id) => {
    location.hash = `#/projects/${id}?tab=environments`;
  }, projectId);
  await page.reload();

  const row = page.getByRole('listitem').filter({ hasText: 'updated' });
  await expect(row).toContainText('.env.prod');

  // Link it. The file of the same name is offered first, with what linking will do.
  await row.getByRole('button', { name: 'Link to a project file' }).click();
  const dialog = page.getByRole('dialog', { name: 'Link .env.prod to a project file' });
  await expect(dialog.getByRole('radio', { name: '.env.prod' })).toBeChecked();
  await expect(
    dialog.getByText("This copy takes the file's contents now.", { exact: false }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Link file' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText('Watching for changes');
  await expect(row.getByRole('button', { name: /to the project folder/ })).toHaveCount(0);

  // Another editor changes the file; the tab catches up on its own.
  writeFileSync(onDisk, 'API_URL=https://two.example\nNEW_KEY=1\n', 'utf-8');
  await expect(row).toContainText('2 keys', { timeout: 15_000 });
  await expect(row).toContainText('updated from the file');

  await row.getByRole('button', { name: 'History' }).click();
  const history = page.getByRole('dialog', { name: 'History of .env.prod' });
  const versions = history.getByRole('listbox', { name: 'Versions' });
  await expect(versions.getByRole('option').first()).toContainText('Updated from the file');
  await expect(versions).toContainText('Linked to a project file');
  await page.keyboard.press('Escape');
  await expect(history).toBeHidden();

  // A save in Runova writes the file back.
  await page.evaluate(async (file) => {
    const api = (
      window as unknown as {
        runova: { environments: { saveFile(input: unknown): Promise<unknown> } };
      }
    ).runova.environments;
    await api.saveFile({
      environmentId: file.environmentId,
      id: file.fileId,
      fileName: '.env.prod',
      content: 'API_URL=https://three.example\n',
    });
  }, saved);
  expect(readFileSync(onDisk, 'utf-8')).toBe('API_URL=https://three.example\n');
  await page.reload();
  await expect(row).toContainText('Watching for changes');
  await expect(row).toContainText('1 key');
});
