// The Monitoring page (E57) against the real API: an account sees its own online monitors and two
// teams', each under its own name; a monitor added elsewhere shows up live over the notifications
// hub; a Member pauses one from its drawer; a Viewer can look but not change. No node runs here,
// so the monitors wait for their first check; results are covered by the API's end to end test.
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import {
  apiCall,
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
// Every new account turns two-factor on and each code works once, so the test waits on the clock.
test.describe.configure({ timeout: 240_000 });

/** An API context signed in as the account: one code, reused by its page. */
async function apiFor(account: Editor): Promise<APIRequestContext> {
  const api = await newApiContext();
  await signIn(api, account.email, account.password, await nextCode(account));
  return api;
}

async function pageFrom(browser: Browser, api: APIRequestContext): Promise<Page> {
  const context = await browser.newContext({
    storageState: await api.storageState(),
    ignoreHTTPSErrors: true,
  });
  return context.newPage();
}

async function makeTeam(api: APIRequestContext, name: string): Promise<number> {
  return (await (await apiCall(api, 'POST', '/teams', { name })).json()).id;
}

async function join(
  lead: APIRequestContext,
  teamId: number,
  member: Editor,
  memberApi: APIRequestContext,
  role: string,
) {
  await apiCall(lead, 'POST', `/teams/${teamId}/invitations`, { email: member.email, role });
  const pending = await (await memberApi.get('/api/v1/invitations')).json();
  const invitation = pending.items.find((each: { teamId: number }) => each.teamId === teamId);
  await apiCall(memberApi, 'POST', `/invitations/${invitation.id}/acceptances`);
}

async function scopeIds(api: APIRequestContext) {
  const scopes: { id: number; kind: string; teamId: number | null }[] = (
    await (await api.get('/api/v1/sync-scopes')).json()
  ).items;
  const idOf = (found: { id: number } | undefined, what: string) => {
    if (!found) throw new Error(`No ${what} sync scope`);
    return found.id;
  };
  return {
    personal: idOf(
      scopes.find((each) => each.kind === 'personal'),
      'personal',
    ),
    team: (teamId: number) =>
      idOf(
        scopes.find((each) => each.teamId === teamId),
        `team ${teamId}`,
      ),
  };
}

function monitor(
  scopeId: number,
  itemId: string,
  name: string,
  projectName: string,
  paused = false,
) {
  return {
    scopeId,
    itemId,
    name,
    projectName,
    environmentName: 'Production',
    url: `https://${itemId}.example.com/health`,
    intervalSec: 300,
    timeoutSec: 10,
    authMode: 'none',
    paused,
  };
}

test("an account sees its own and both teams' monitors live, pauses one, and a Viewer can only look", async ({
  browser,
  owner,
}, info) => {
  const lead = await createEditor(owner, info.workerIndex);
  const viewer = await createEditor(owner, info.workerIndex);
  const leadApi = await apiFor(lead);
  const viewerApi = await apiFor(viewer);
  const tag = Date.now().toString(36);
  const platform = await makeTeam(leadApi, `Platform ${tag}`);
  const growth = await makeTeam(leadApi, `Growth ${tag}`);
  await join(leadApi, platform, viewer, viewerApi, 'viewer');
  const scopes = await scopeIds(leadApi);
  const api = await (
    await apiCall(
      leadApi,
      'POST',
      '/cloud-monitors',
      monitor(scopes.personal, `api-${tag}`, 'API', 'Storefront'),
    )
  ).json();
  await apiCall(
    leadApi,
    'POST',
    '/cloud-monitors',
    monitor(scopes.team(platform), `billing-${tag}`, 'Billing', 'Payments'),
  );
  await apiCall(
    leadApi,
    'POST',
    '/cloud-monitors',
    monitor(scopes.team(growth), `landing-${tag}`, 'Landing', 'Site'),
  );

  const page = await pageFrom(browser, leadApi);
  await page.goto('/account/monitoring');
  await expect(page.getByRole('heading', { level: 1, name: 'Monitoring' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Personal' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: `Platform ${tag}` })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: `Growth ${tag}` })).toBeVisible();
  await expect(page.getByText('3 waiting for their first check')).toBeVisible();
  // The hub connects with the session cookie.
  await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 20_000 });

  // Added somewhere else, it shows here without a reload.
  await apiCall(
    leadApi,
    'POST',
    '/cloud-monitors',
    monitor(scopes.personal, `worker-${tag}`, 'Worker', 'Storefront', true),
  );
  await expect(page.getByRole('article', { name: 'Worker' })).toBeVisible({ timeout: 10_000 });

  // A Member pauses one from its drawer; the server has it.
  await page.getByRole('button', { name: 'Open API' }).click();
  const drawer = page.getByRole('dialog', { name: 'API' });
  await expect(drawer.getByText('No incidents yet.')).toBeVisible();
  // The box follows the server: it turns once the change is saved.
  await drawer.getByRole('checkbox', { name: /^Paused/ }).click();
  await expect(drawer.getByRole('checkbox', { name: /^Paused/ })).toBeChecked();
  await expect
    .poll(async () => (await (await leadApi.get(`/api/v1/cloud-monitors/${api.id}`)).json()).paused)
    .toBe(true);
  await drawer.getByRole('button', { name: 'Close' }).click();

  // On a phone nothing scrolls sideways: not the page, and not a card's 90 days of bars.
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(page.getByRole('article', { name: 'API' })).toBeVisible();
  const overflow = await page.evaluate(() => [
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ...[...document.querySelectorAll('article')].map((card) => card.scrollWidth - card.clientWidth),
  ]);
  expect(Math.max(...overflow), 'something scrolls sideways on a phone').toBeLessThanOrEqual(0);

  // The Viewer sees the team's monitor and its settings read only, with why.
  const viewerPage = await pageFrom(browser, viewerApi);
  await viewerPage.goto('/account/monitoring');
  await viewerPage.getByRole('button', { name: 'Open Billing' }).click();
  const viewerDrawer = viewerPage.getByRole('dialog', { name: 'Billing' });
  await expect(viewerDrawer.getByText('You can look, not change')).toBeVisible();
  await expect(viewerDrawer.getByRole('checkbox', { name: /^Paused/ })).toBeDisabled();
  await expect(viewerDrawer.getByRole('combobox', { name: /Check every/ })).toBeDisabled();
  await expect(viewerDrawer.getByRole('checkbox', { name: /Mute for me/ })).toBeEnabled();
  await expect(viewerPage.getByRole('heading', { level: 2, name: `Growth ${tag}` })).toHaveCount(0);

  await leadApi.dispose();
  await viewerApi.dispose();
});
