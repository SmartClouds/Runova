import { expect, SIGNED_OUT, test, uniqueTitle } from './fixtures';
import { ADMIN_BASE_URL } from './stackConfig';

test.use({
  storageState: async ({ adminSession }, use) => use(adminSession),
  permissions: ['clipboard-read', 'clipboard-write'],
});

test('an Admin invites a user, whose link sets a password once, and who then signs in', async ({
  page,
  browser,
}) => {
  const displayName = uniqueTitle('Invited');
  const email = `${displayName.replace(/\W+/g, '-').toLowerCase()}@e2e.runovahq.test`;
  const password = `password-of-${email}`;

  await page.goto('/admin/users/new');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Name').fill(displayName);
  await page.getByRole('button', { name: 'Create invitation' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: `${displayName} is invited` }),
  ).toBeFocused();

  await page.getByRole('button', { name: 'Copy invitation link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Copied.' })).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(await page.getByRole('textbox', { name: 'Invitation link' }).inputValue());
  expect(link).toMatch(/\/admin\/set-password#token=/);

  await page.getByRole('link', { name: `Open ${displayName}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: displayName })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Role' })).toHaveValue('Editor');

  // The new user opens the link in a browser of their own.
  const theirs = await browser.newContext({
    baseURL: ADMIN_BASE_URL,
    storageState: SIGNED_OUT,
    ignoreHTTPSErrors: true,
  });
  try {
    const invitee = await theirs.newPage();
    await invitee.goto(link);
    await expect(invitee).toHaveURL(/\/admin\/set-password$/);
    await invitee.getByLabel('New password').fill(password);
    await invitee.getByLabel('Repeat the password').fill(password);
    await invitee.getByRole('button', { name: 'Set password' }).click();
    await expect(invitee.getByText('Your password is set.')).toBeFocused();

    // The link works once. Leaving the page first makes the second visit load it again.
    await invitee.goto('about:blank');
    await invitee.goto(link);
    await invitee.getByLabel('New password').fill(`${password}-again`);
    await invitee.getByLabel('Repeat the password').fill(`${password}-again`);
    await invitee.getByRole('button', { name: 'Set password' }).click();
    await expect(
      invitee.getByText('This link was already used or has expired. Ask an Admin for a new one.'),
    ).toBeVisible();

    await invitee.goto('/admin/sign-in');
    await invitee.getByLabel('Email').fill(email);
    await invitee.getByLabel('Password').fill(password);
    await invitee.getByRole('button', { name: 'Sign in' }).click();
    await expect(invitee).toHaveURL(/\/admin$/);
    await expect(
      invitee.getByRole('heading', { level: 1, name: `Hello, ${displayName}` }),
    ).toBeVisible();
    // An Editor sees none of the Admin pages in the menu.
    const menu = invitee.getByRole('navigation', { name: 'Admin' });
    await expect(menu.getByRole('link')).toHaveText(['News', 'Blog']);
  } finally {
    await theirs.close();
  }
});
