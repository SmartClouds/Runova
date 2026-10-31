import { expect, SIGNED_OUT, test } from './fixtures';
import { nextCode, timeStep, totpCode } from './totp';

test.use({ storageState: SIGNED_OUT });

test('an Editor signs in with a code, lands on the page they asked for, and signs out', async ({
  page,
  editor,
}) => {
  await page.goto('/admin/news');
  await expect(page).toHaveURL(/\/admin\/sign-in\?next=%2Fadmin%2Fnews$/);

  await page.getByLabel('Email').fill(editor.email);
  await page.getByLabel('Password').fill(editor.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // A code that is not this user's shows its error on the code field.
  const code = page.getByLabel('Authentication code');
  await expect(code).toBeFocused();
  const wrong = totpCode('JBSWY3DPEHPK3PXP', timeStep());
  await code.fill(wrong);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(code).toHaveAccessibleDescription(/The code is not right or was already used\./);

  await code.fill(await nextCode(editor));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/news$/);
  await expect(page.getByRole('heading', { level: 1, name: 'News' })).toBeVisible();
  await expect(page.getByText(editor.displayName)).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/sign-in\?next=%2Fadmin$/);
});

test('a wrong password shows the API message and keeps the email', async ({ page, editor }) => {
  await page.goto('/admin/sign-in');
  await page.getByLabel('Email').fill(editor.email);
  await page.getByLabel('Password').fill('not-the-password-at-all');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('The email or password is not right.').first()).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveValue(editor.email);
});
