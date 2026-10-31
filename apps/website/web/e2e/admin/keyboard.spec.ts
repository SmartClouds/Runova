import type { Locator, Page } from '@playwright/test';
import sharp from 'sharp';
import { expect, SIGNED_OUT, test, uniqueTitle } from './fixtures';
import { nextCode } from './totp';

// Everything here is done with the keyboard: Tab to move, typing, arrows, Space and Enter.

/** Presses Tab until the target has focus, failing when it never gets there. */
async function tabTo(page: Page, target: Locator, limit = 80) {
  for (let presses = 0; presses < limit; presses += 1) {
    if (await target.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

test.describe('signed out', () => {
  test.use({ storageState: SIGNED_OUT });

  test('signs in with the keyboard alone', async ({ page, editor }) => {
    await page.goto('/admin/sign-in');
    await tabTo(page, page.getByLabel('Email'));
    await page.keyboard.type(editor.email);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password')).toBeFocused();
    await page.keyboard.type(editor.password);
    await page.keyboard.press('Enter');

    await expect(page.getByLabel('Authentication code')).toBeFocused();
    await page.keyboard.type(await nextCode(editor));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/admin$/);

    await tabTo(
      page,
      page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'News' }),
    );
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'News' })).toBeVisible();
  });
});

test('writes and publishes a news item with the keyboard alone', async ({ page }) => {
  const title = uniqueTitle('Keyboard news');
  await page.goto('/admin/news');
  await tabTo(page, page.getByRole('link', { name: 'New news item' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'New news item' })).toBeVisible();

  // Saving the empty form puts the API's messages next to their fields.
  await tabTo(page, page.getByRole('button', { name: 'Save', exact: true }));
  await page.keyboard.press('Enter');
  const summary = page.getByRole('alert');
  await expect(summary).toBeFocused();
  await expect(page.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Title')).toHaveAccessibleDescription(/\S/);
  await expect(page.getByLabel('Summary')).toHaveAttribute('aria-invalid', 'true');

  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Title')).toBeFocused();
  await page.keyboard.type(title);
  await tabTo(page, page.getByLabel('Summary'));
  await page.keyboard.type('Written without touching the mouse, start to end.');

  await tabTo(page, page.getByLabel('Category'));
  await page.keyboard.type('Tooling');
  await expect(page.getByLabel('Category')).toHaveValue('tooling');

  await tabTo(page, page.getByLabel('Technology to add'));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Add technology' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(1);

  await tabTo(page, page.getByLabel('Body (Markdown)'));
  await page.keyboard.type('Typed with **keys** only.');
  await expect(page.getByRole('region', { name: 'Preview' }).locator('strong')).toHaveText('keys');

  await tabTo(page, page.getByRole('radio', { name: 'Draft' }));
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Publish now' })).toBeChecked();

  await tabTo(page, page.getByRole('button', { name: 'Save', exact: true }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Saved.');
  await expect(page.getByLabel('Title')).not.toHaveAttribute('aria-invalid');
});

test('writes a post with a cover with the keyboard alone', async ({ page }) => {
  const title = uniqueTitle('Keyboard post');
  await page.goto('/admin/blog/new');
  await tabTo(page, page.getByLabel('Title'));
  await page.keyboard.type(title);
  await tabTo(page, page.getByLabel('Excerpt'));
  await page.keyboard.type('A post written with the keyboard alone.');
  await tabTo(page, page.getByLabel('Tags'));
  await page.keyboard.type('keyboard');

  // Space on the file input opens the system picker, which Playwright stands in for.
  await tabTo(page, page.getByLabel('Cover image file'));
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Space');
  await (await chooser).setFiles({
    name: 'cover.png',
    mimeType: 'image/png',
    buffer: await sharp({
      create: { width: 1200, height: 630, channels: 3, background: '#2f855a' },
    })
      .png()
      .toBuffer(),
  });
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Alt text')).toBeFocused();
  await page.keyboard.type('A green field');
  await tabTo(page, page.getByRole('button', { name: 'Upload cover' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('img', { name: 'A green field' })).toBeVisible();

  await tabTo(page, page.getByLabel('Body (Markdown)'));
  await page.keyboard.type('Hello from the keyboard.');
  await tabTo(page, page.getByRole('button', { name: 'Save', exact: true }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Saved.');
});

test('filters the list and answers the conflict dialog with the keyboard alone', async ({
  page,
  context,
}) => {
  const title = uniqueTitle('Keyboard conflict');
  await page.goto('/admin/blog/new');
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Excerpt').fill('Two tabs, one keyboard and a conflict.');
  await page.getByLabel('Body (Markdown)').fill('Draft.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
  const url = page.url();

  const theirs = await context.newPage();
  await theirs.goto(url);
  await theirs.getByLabel('Title').fill(`${title} by them`);
  await theirs.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(theirs.getByRole('status')).toHaveText('Saved.');

  await tabTo(page, page.getByLabel('Excerpt'));
  await page.keyboard.type(' Mine.');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await tabTo(page, save);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: 'Someone else saved this item' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(save).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await tabTo(page, dialog.getByRole('button', { name: 'Load their version' }), 5);
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Title')).toHaveValue(`${title} by them`);

  await page.goto('/admin/blog');
  await tabTo(page, page.getByLabel('Status'));
  await page.keyboard.press('ArrowDown');
  await expect(page.getByLabel('Status')).toHaveValue('draft');
  await expect(page).toHaveURL(/status=draft/);
  await tabTo(page, page.getByRole('link', { name: `${title} by them` }));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(url);
});
