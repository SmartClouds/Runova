// The account panel (E48) against the real API: signing in through it, the profile, the session
// list and a team from invitation to role change. Each test makes accounts of its own, since a
// rename or a team would leak into the worker's shared Editor.
import type { Browser, Page } from '@playwright/test';
import {
  createEditor,
  type Editor,
  expect,
  newApiContext,
  SIGNED_OUT,
  signIn,
  test,
} from './fixtures';
import { nextCode } from './totp';

test.use({ storageState: SIGNED_OUT });
// Every new account turns two-factor on and each code works once, so the tests wait on the clock.
test.describe.configure({ timeout: 120_000 });

/** A browser page signed in as `account`, through the API. */
async function pageFor(browser: Browser, account: Editor): Promise<Page> {
  const api = await newApiContext();
  await signIn(api, account.email, account.password, await nextCode(account));
  const state = await api.storageState();
  await api.dispose();
  const context = await browser.newContext({ storageState: state, ignoreHTTPSErrors: true });
  return context.newPage();
}

const shot = async (page: Page, name: string) =>
  test
    .info()
    .attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

test('signs in through the panel with the two-factor code and lands on the page it came for', async ({
  page,
  owner,
}, info) => {
  const account = await createEditor(owner, info.workerIndex);

  await page.goto('/account/security');
  await expect(page).toHaveURL(/\/account\/sign-in\?next=%2Faccount%2Fsecurity$/);
  await page.getByLabel('Email').fill(account.email);
  const password = page.getByLabel(/^Password/);
  await password.fill(account.password);
  await expect(password).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await shot(page, 'sign-in');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByLabel('Code').fill(await nextCode(account));
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/account\/security$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
  await shot(page, 'security');
});

test('renames the account on Profile and shows this browser among the sessions', async ({
  browser,
  owner,
}, info) => {
  const account = await createEditor(owner, info.workerIndex);
  const page = await pageFor(browser, account);

  await page.goto('/account/profile');
  const name = page.getByLabel('Name', { exact: true });
  await expect(name).toHaveValue(account.displayName);
  await name.fill('Sam Renamed');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await shot(page, 'profile');

  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Sam Renamed');

  await page.goto('/account/sessions');
  await expect(page.getByText('This browser')).toBeVisible();
  await shot(page, 'sessions');
});

test('makes a team, invites a person as Viewer, and once they join makes them Member', async ({
  browser,
  owner,
}, info) => {
  const lead = await createEditor(owner, info.workerIndex);
  const invitee = await createEditor(owner, info.workerIndex);
  const page = await pageFor(browser, lead);
  const teamName = `Platform ${Date.now().toString(36)}`;

  await page.goto('/account/teams');
  await page.getByLabel('Team name').fill(teamName);
  await page.getByRole('button', { name: 'Make team' }).click();
  // Making the team opens its page.
  await expect(page).toHaveURL(/\/account\/teams\/\d+$/);
  await expect(page.getByRole('heading', { level: 1, name: teamName })).toBeVisible();

  await page.getByLabel('Email', { exact: true }).fill(invitee.email);
  await page.getByRole('radio', { name: /^Viewer/ }).check();
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText(`Invitation sent to ${invitee.email}.`)).toBeVisible();

  const inviteePage = await pageFor(browser, invitee);
  await inviteePage.goto('/account/invitations');
  await inviteePage.getByRole('button', { name: `Join ${teamName}` }).click();
  await expect(inviteePage.getByRole('button', { name: `Join ${teamName}` })).toHaveCount(0);

  await page.reload();
  const role = page.getByLabel(`Role of ${invitee.displayName}`);
  await expect(role).toHaveValue('viewer');
  await shot(page, 'team');
  await role.selectOption('member');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Your password').fill(lead.password);
  await shot(page, 'team step-up');
  await dialog.getByRole('button', { name: 'Change role' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByLabel(`Role of ${invitee.displayName}`)).toHaveValue('member');
});
