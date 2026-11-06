// Monitoring nodes (E54) against the real API: an Admin adds a node, gets its token and the files
// to run it once, removes it, and sees a revoked one apart. No node runs here; the link itself is tested in the API suite.
import { apiCall, expect, test } from './fixtures';

test.use({ storageState: async ({ adminSession }, use) => use(adminSession) });

test('an Admin adds a node, gets its token once and removes it', async ({ page }) => {
  const name = `e2e-${Date.now().toString(36)}`;
  await page.goto('/admin/monitoring-nodes');
  await expect(page.getByRole('heading', { name: 'Monitoring nodes', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Add node' }).click();
  const add = page.getByRole('alertdialog', { name: 'Add a monitoring node' });
  await add.getByLabel('Name').fill(name);
  await add.getByLabel('Region').fill('EU Central');
  await add.getByRole('button', { name: 'Add node' }).click();
  await expect(add.getByText('Give 2 to 32 lower-case letters, digits and dashes')).toBeVisible();
  await add.getByLabel('Region').fill('eu-central');
  await add.getByRole('button', { name: 'Add node' }).click();

  const start = page.getByRole('alertdialog', { name: `Start ${name}` });
  await expect(start.getByLabel('.env')).toHaveValue(
    /^NODE_ENROLLMENT_TOKEN=rnn_[\w-]{20,}\nRUNOVA_API_URL=https:\/\//,
  );
  await expect(start.getByLabel('compose.yaml')).toHaveValue(/runova-website-monitoring-node/);
  await expect(start.getByLabel('compose.yaml')).toHaveValue(/read_only: true/);
  await start.getByRole('button', { name: 'Done' }).click();

  const card = page.getByRole('article', { name: name });
  await expect(card).toContainText('Waiting to enroll');
  await expect(card).toContainText('eu-central');
  await expect(card).toContainText(/Its token works in 2[34] h/);

  // A node that never enrolled is removed; revoking is for one that did.
  await card.getByRole('button', { name: `Remove ${name}` }).click();
  await page
    .getByRole('alertdialog', { name: `Remove ${name}?` })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.getByRole('status')).toHaveText(`${name} was removed.`);
  await expect(card).toHaveCount(0);
});

test('a fresh token is shown once, and a revoked node moves to its own list', async ({
  page,
  owner,
}) => {
  const name = `e2e-${Date.now().toString(36)}-r`;
  const created = await apiCall(owner, 'POST', '/monitoring-nodes', { name, region: 'us-east' });
  const { node } = await created.json();

  await page.goto('/admin/monitoring-nodes');
  const card = page.getByRole('article', { name });
  await expect(card).toContainText('Waiting to enroll');

  // A fresh token replaces the old one and is shown once.
  await card.getByRole('button', { name: `New token for ${name}` }).click();
  await expect(
    page.getByRole('alertdialog', { name: `Start ${name}` }).getByLabel('.env'),
  ).toHaveValue(/rnn_/);
  await page.getByRole('button', { name: 'Done' }).click();

  await apiCall(owner, 'POST', `/monitoring-nodes/${node.id}/revocations`);
  await page.reload();
  await expect(page.getByRole('article', { name })).toHaveCount(0);
  await page.getByText(/revoked nodes?$/).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
});
