import { expect, test } from './fixtures';
import { OWNER } from './stackConfig';

// The owner signs in with the password the stack gave the API in its Admin__* settings, so every
// spec here also proves the API made that Admin on start.
test.use({ storageState: async ({ adminSession }, use) => use(adminSession) });

/** The number a report tile shows under its label. */
const tileValue = (page: import('@playwright/test').Page, label: string) =>
  page
    .locator('dt', { hasText: new RegExp(`^${label}$`) })
    .locator('xpath=following-sibling::dd[1]');

test('the owner from the settings is an Admin the users list finds by type and email', async ({
  page,
}) => {
  await page.goto('/admin/users');
  await page.getByLabel('Type').selectOption('Admin');
  await expect(page).toHaveURL(/\/admin\/users\?role=Admin$/);
  await page.getByRole('searchbox', { name: 'Name or email' }).fill(OWNER.email);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/\?q=owner%40e2e\.runovahq\.test&role=Admin$/);

  const row = page.getByRole('row', { name: new RegExp(OWNER.displayName) });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('cell').nth(1)).toHaveText('Admin');

  await page.getByLabel('Type').selectOption('Account');
  await expect(page.getByText('No users match these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.getByRole('link', { name: OWNER.displayName, exact: true })).toBeVisible();
});

// Asking for the worker's Editor makes sure one exists before the counts are read.
test('an Admin reads the reports and picks another period', async ({ page, editor: _editor }) => {
  await page.goto('/admin');
  await page
    .getByRole('navigation', { name: 'Admin' })
    .getByRole('link', { name: 'Reports' })
    .click();
  await expect(page).toHaveURL(/\/admin\/reports$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();

  // At least the owner and this worker's Editor exist, and both are staff.
  await expect(page.getByRole('heading', { level: 2, name: 'Users' })).toBeVisible();
  expect(
    Number((await tileValue(page, 'All users').textContent())?.replace(/,/g, '')),
  ).toBeGreaterThanOrEqual(2);
  expect(
    Number((await tileValue(page, 'Staff').textContent())?.replace(/,/g, '')),
  ).toBeGreaterThanOrEqual(2);
  // The Editor was made for this run, so they joined today and count in every period.
  expect(
    Number((await tileValue(page, 'Joined').textContent())?.replace(/,/g, '')),
  ).toBeGreaterThanOrEqual(1);
  await expect(page.getByText(/\d+ in the last 30 days/)).toBeVisible();
  await expect(page.getByTestId('sign-up-bar')).toHaveCount(30);

  for (const heading of ['Sessions and computers', 'Teams and sync', 'Content']) {
    await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
  }

  await page.getByLabel('Period').selectOption('7');
  await expect(page).toHaveURL(/\/admin\/reports\?days=7$/);
  await expect(page.getByText(/\d+ in the last 7 days/)).toBeVisible();
  await expect(page.getByTestId('sign-up-bar')).toHaveCount(7);

  // A reload keeps the period.
  await page.reload();
  await expect(page.getByLabel('Period')).toHaveValue('7');
  await expect(page.getByTestId('sign-up-bar')).toHaveCount(7);

  await page.getByRole('link', { name: 'Runova accounts' }).click();
  await expect(page).toHaveURL(/\/admin\/users\?role=Account$/);
  await expect(page.getByLabel('Type')).toHaveValue('Account');
});

test('the sign-ups table shows every day of the period', async ({ page }) => {
  await page.goto('/admin/reports?days=7');
  await page.getByText('Show as a table').click();
  const table = page.getByRole('table', { name: 'Sign-ups' });
  await expect(table.getByRole('row')).toHaveCount(8);
});
