import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { initGitRepo, type LaunchedApp, launchApp, openWorkspace } from './app';

/**
 * "Update version in files" takes minutes, so its dialog shows what the CLI is doing as it
 * happens: a read-only log at the foot of the running card. This drives the real dialog with a
 * fake Claude Code that streams its steps (fixtures/fakeVersionBumpClaude.cjs) and holds the run
 * open until the test lets it finish.
 */

const FAKE_CLAUDE = join(__dirname, 'fixtures', 'fakeVersionBumpClaude.cjs');

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({
    settings: { defaultCliId: 'claude-code' },
    claudeScript: FAKE_CLAUDE,
  });
  initGitRepo(launched);
  await openWorkspace(launched);
});

test.afterAll(async () => {
  await launched?.close();
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright wants its fixtures destructured
test('the version bump shows its steps live, keeps them when reopened, and folds them away after', async ({}, info) => {
  const { page } = launched;

  await page.getByRole('button', { name: 'Tag a version' }).click();
  const tagDialog = page.getByRole('dialog', { name: 'Tag a version' });
  await tagDialog.getByRole('textbox', { name: 'Version', exact: true }).fill('1.1.0');
  await tagDialog.getByRole('button', { name: /Update version in files/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Update version in files' });
  const output = dialog.getByRole('log', { name: 'Run output' });
  await expect(dialog.getByText('Live output')).toBeVisible();
  await expect(output).toContainText('Looking for every file that carries a version.');
  await expect(output).toContainText('Glob **/package.json');
  await expect(output).toContainText('Edit package.json');
  await expect(output).toContainText('$ git status --short');
  await expect(output).toContainText('✗ Permission to use Bash denied.');
  // A view of the run, never a prompt: there is nothing in it to type into.
  await expect(output.getByRole('textbox')).toHaveCount(0);
  await dialog.screenshot({ path: info.outputPath('live-log.png') });

  // Closed and opened again mid-run, it still has every line from before.
  await dialog.getByRole('button', { name: 'Close, keep it running' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Tag a version' }).click();
  await expect(output).toContainText('Edit package.json');
  await expect(output).toContainText('Looking for every file that carries a version.');

  writeFileSync(join(launched.root, 'bump-gate'), '');

  const toggle = dialog.getByRole('button', { name: 'Run log', exact: true });
  await expect(toggle).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText('Live output')).toHaveCount(0);
  await expect(output).toHaveCount(0);
  await toggle.click();
  await expect(output).toContainText('Edit package.json');
  await dialog.screenshot({ path: info.outputPath('finished-log.png') });
});
