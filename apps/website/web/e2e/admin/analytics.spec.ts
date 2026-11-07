import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { antiforgeryToken, expect, SIGNED_OUT, test } from './fixtures';

// An Admin sets the tracking tags and verifications (E59), a visitor's page loads the tags, the
// consent banner holds them back until the visitor allows them, and turning them off stops them.
// The tags are on for the whole stack while this runs, so everything is cleared however the steps
// end. Google and Microsoft are never reached: the browser's requests for their scripts are
// answered here.

const GA = 'G-E2ETAG1234';
const CLARITY = 'e2eclarity1';
const UET = '187654321';
const GOOGLE_FILE = 'google0123456789e2e0';
const BING_CODE = '0123456789ABCDEF0123456789ABCDEF';
const TAG_SCRIPT = /^https:\/\/(www\.googletagmanager\.com|www\.clarity\.ms|bat\.bing\.com)\//;

test.use({ storageState: async ({ adminSession }, use) => use(adminSession) });

/** Clears every setting through the API, the way the settings page would. */
async function clearAll(owner: APIRequestContext) {
  const current = await owner.get('/api/v1/analytics-settings');
  const response = await owner.fetch('/api/v1/analytics-settings', {
    method: 'PATCH',
    data: {
      tagsEnabled: false,
      googleAnalyticsIds: [],
      googleAdsIds: [],
      googleTagManagerId: null,
      clarityProjectId: null,
      bingUetTagId: null,
      googleSiteVerification: null,
      bingSiteVerification: null,
      consentBannerEnabled: false,
    },
    headers: {
      'If-Match': current.headers().etag ?? '',
      'X-XSRF-TOKEN': await antiforgeryToken(owner),
    },
  });
  expect(response.ok()).toBe(true);
}

interface Visitor {
  page: Page;
  /** The tag scripts the page asked for, by host. */
  tags: string[];
  csp: string[];
  close: () => Promise<void>;
}

/** A visitor with an empty cache, whose requests for tag scripts are answered with empty scripts. */
async function visitor(browser: Browser): Promise<Visitor> {
  const context = await browser.newContext({ storageState: SIGNED_OUT, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const tags: string[] = [];
  const csp: string[] = [];
  await page.route(TAG_SCRIPT, (route) => {
    tags.push(new URL(route.request().url()).host);
    return route.fulfill({ contentType: 'text/javascript', body: '' });
  });
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) csp.push(message.text());
  });
  return { page, tags, csp, close: () => context.close() };
}

/** Opens the home page and waits for its read of the tags. */
async function openHome({ page }: Visitor) {
  const read = page.waitForResponse((response) => response.url().endsWith('/nav/analytics.json'));
  await page.goto('/');
  return (await read).json();
}

async function save(page: Page) {
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/^Saved\./)).toBeVisible();
}

/** Opens the analytics settings as the owner. */
async function openSettings(page: Page) {
  await page.goto('/admin/settings/analytics');
  await expect(page.getByLabel('Google Analytics measurement IDs')).toBeVisible();
}

// One flow in steps that build on each other; the settings are shared by the whole stack.
test.describe.configure({ mode: 'serial' });

test.afterAll(async ({ owner }) => {
  await clearAll(owner);
});

test('an Admin saves the tags and verifications, and the site serves both files', async ({
  page,
}) => {
  await page.goto('/admin/settings');
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('link', { name: 'Analytics' })
    .click();
  await expect(page).toHaveURL(/\/admin\/settings\/analytics$/);
  await expect(page.getByText(/The tags are off/)).toBeVisible();

  await page.getByLabel('Google Analytics measurement IDs').fill(GA.toLowerCase());
  await page.getByLabel('Microsoft Clarity project ID').fill(CLARITY.toUpperCase());
  await page.getByLabel('Microsoft Advertising (Bing) UET tag ID').fill(UET);
  await page.getByLabel('Search Console verification file').fill(`${GOOGLE_FILE}.html`);
  await page.getByLabel('Bing Webmaster verification code').fill(BING_CODE);
  await page.getByRole('checkbox', { name: /Load the tracking tags/ }).check();
  await save(page);
  await expect(page.getByLabel('Google Analytics measurement IDs')).toHaveValue(GA);
  await expect(page.getByLabel('Microsoft Clarity project ID')).toHaveValue(CLARITY);
  await expect(page.getByText('The tags load on the public pages.')).toBeVisible();

  const google = await page.request.get(`/${GOOGLE_FILE}.html`);
  expect(await google.text()).toBe(`google-site-verification: ${GOOGLE_FILE}.html`);
  const bing = await page.request.get('/BingSiteAuth.xml');
  expect(await bing.text()).toContain(`<user>${BING_CODE}</user>`);
});

test("a visitor's page loads every tag with no CSP error, and the admin page loads none", async ({
  page,
  browser,
}) => {
  const open = await visitor(browser);
  expect((await openHome(open)).googleAnalyticsIds).toEqual([GA]);
  await expect
    .poll(() => [...new Set(open.tags)].sort())
    .toEqual(['bat.bing.com', 'www.clarity.ms', 'www.googletagmanager.com']);
  await expect(open.page.locator('[data-consent-banner]')).toBeHidden();
  expect(open.csp).toEqual([]);
  await open.close();

  let adminTags = 0;
  await page.route(TAG_SCRIPT, (route) => {
    adminTags += 1;
    return route.fulfill({ contentType: 'text/javascript', body: '' });
  });
  await openSettings(page);
  await expect(page.getByLabel('Google Analytics measurement IDs')).toHaveValue(GA);
  expect(adminTags).toBe(0);
});

test('with the banner on, nothing loads until the visitor allows it, and the answer is kept', async ({
  page,
  browser,
}) => {
  await openSettings(page);
  await page.getByRole('checkbox', { name: /Ask each visitor first/ }).check();
  await save(page);

  const asked = await visitor(browser);
  await openHome(asked);
  const banner = asked.page.getByRole('region', { name: 'Cookies on this site' });
  await expect(banner).toBeVisible();
  expect(asked.tags).toEqual([]);
  await banner.getByRole('button', { name: 'Allow' }).click();
  await expect(banner).toBeHidden();
  await expect.poll(() => asked.tags.length).toBeGreaterThanOrEqual(3);
  await asked.page.reload();
  await expect(asked.page.getByRole('button', { name: 'Cookie settings' })).toBeVisible();
  await expect(banner).toBeHidden();
  expect(asked.csp).toEqual([]);
  await asked.close();

  const declined = await visitor(browser);
  await openHome(declined);
  await declined.page.getByRole('button', { name: 'Decline' }).click();
  await declined.page.reload();
  await expect(declined.page.getByRole('region', { name: 'Cookies on this site' })).toBeHidden();
  expect(declined.tags).toEqual([]);
  await declined.close();
});

test('with the tags off a visitor gets none, but the verifications stay', async ({
  page,
  browser,
}) => {
  await openSettings(page);
  await page.getByRole('checkbox', { name: /Load the tracking tags/ }).uncheck();
  await save(page);
  await expect(page.getByText(/The tags are off/)).toBeVisible();

  const off = await visitor(browser);
  expect((await openHome(off)).googleAnalyticsIds).toEqual([]);
  expect(off.tags).toEqual([]);
  expect((await off.page.request.get('/BingSiteAuth.xml')).status()).toBe(200);
  await off.close();
});

test('clearing the codes takes the verification files away', async ({ page, owner }) => {
  await clearAll(owner);

  expect((await page.request.get('/BingSiteAuth.xml')).status()).toBe(404);
  expect((await page.request.get(`/${GOOGLE_FILE}.html`)).status()).toBe(404);
});
