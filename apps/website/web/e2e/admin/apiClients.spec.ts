import type { Page } from '@playwright/test';
import { signRequest } from '../../../../../docs/website/examples/sign-request.ts';
import { expect, newApiContext, test, uniqueTitle } from './fixtures';

test.use({
  storageState: async ({ adminSession }, use) => use(adminSession),
  permissions: ['clipboard-read', 'clipboard-write'],
});

interface Key {
  keyId: string;
  secret: string;
}

/** The status the API gives a request signed with the key, sent without any cookie. */
async function signedStatus({ keyId, secret }: Key): Promise<number> {
  const url = '/api/v1/news?status=draft';
  const context = await newApiContext();
  try {
    const response = await context.get(url, {
      headers: signRequest({ keyId, secret, method: 'GET', url }),
    });
    return response.status();
  } finally {
    await context.dispose();
  }
}

/** Reads the key from the one-time dialog, checks the copy button, and closes the dialog. */
async function takeSecret(page: Page): Promise<Key> {
  const dialog = page.getByRole('alertdialog', { name: 'Copy the secret now' });
  await expect(dialog).toBeVisible();
  const keyId = (await dialog.getByRole('definition').textContent())?.trim() ?? '';
  const secret = await dialog.getByRole('textbox', { name: 'Secret' }).inputValue();
  expect(keyId).toMatch(/^rk_[0-9a-f]{16}$/);
  expect(secret).toMatch(/^rnv_sk_/);

  // Escape does not throw the only copy away.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: 'Copy secret' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);

  await dialog.getByRole('button', { name: 'I have saved the secret' }).click();
  await expect(dialog).toBeHidden();
  return { keyId, secret };
}

/** The client's row in the list of clients that are revoked or not, once the list has loaded. */
async function listRow(page: Page, name: string, revoked: boolean) {
  await page.goto(revoked ? '/admin/api-clients?show=revoked' : '/admin/api-clients');
  await expect(page.getByRole('heading', { level: 1, name: 'API clients' })).toBeVisible();
  await expect(page.getByText('Loading.')).toBeHidden();
  return page.getByRole('row').filter({ has: page.getByRole('rowheader', { name }) });
}

test('an Admin creates, rotates and revokes an API client, and the API follows', async ({
  page,
}) => {
  const name = uniqueTitle('E2E client');

  await page.goto('/admin/api-clients/new');
  await page.getByLabel('Name').fill(name);
  await page.getByRole('checkbox', { name: /Write news/ }).check();
  await page.getByRole('button', { name: 'Create client' }).click();
  const first = await takeSecret(page);
  await expect(page).toHaveURL(/\/admin\/api-clients\/\d+$/);
  const clientUrl = page.url();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  // The secret is never shown again, not on the page and not in what the API sends it.
  const answers: string[] = [];
  page.on('response', async (response) => {
    if (response.url().includes('/api/v1/api-clients')) answers.push(await response.text());
  });
  await page.reload();
  await expect(page.getByRole('cell', { name: first.keyId })).toBeVisible();
  expect(await page.content()).not.toContain(first.secret);
  await expect.poll(() => answers.length).toBeGreaterThan(0);
  for (const answer of answers) expect(answer).not.toContain(first.secret);

  expect(await signedStatus(first)).toBe(200);
  let row = await listRow(page, name, false);
  await expect(row).toContainText(first.keyId);
  await expect(row).toContainText('Active');

  // Rotating with no overlap stops the old key at once.
  await page.goto(clientUrl);
  await page.getByRole('button', { name: 'Rotate secret' }).click();
  const rotateDialog = page.getByRole('alertdialog', { name: 'Rotate the secret?' });
  await rotateDialog
    .getByLabel('The old key keeps working')
    .selectOption({ label: 'Not at all, stop it now' });
  await rotateDialog.getByRole('button', { name: 'Rotate' }).click();
  const second = await takeSecret(page);
  expect(second.keyId).not.toBe(first.keyId);
  await expect(page.getByRole('button', { name: 'Rotate secret' })).toBeFocused();

  expect(await signedStatus(first)).toBe(401);
  expect(await signedStatus(second)).toBe(200);
  row = await listRow(page, name, false);
  await expect(row).toContainText(second.keyId);

  // Revoking asks first, and Cancel leaves the client as it was.
  await page.goto(clientUrl);
  await page.getByRole('button', { name: 'Revoke client' }).click();
  const revokeDialog = page.getByRole('alertdialog', { name: `Revoke ${name}?` });
  await revokeDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(revokeDialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Revoke client' })).toBeFocused();
  expect(await signedStatus(second)).toBe(200);

  await page.getByRole('button', { name: 'Revoke client' }).click();
  await revokeDialog.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText(/This client was revoked on/)).toBeFocused();
  await expect(page.getByRole('button', { name: 'Rotate secret' })).toBeHidden();

  expect(await signedStatus(second)).toBe(401);
  await expect(await listRow(page, name, false)).toHaveCount(0);
  row = await listRow(page, name, true);
  await expect(row).toContainText('Revoked');
});
