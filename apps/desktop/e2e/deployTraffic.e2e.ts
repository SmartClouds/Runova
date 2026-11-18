import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';
import { addSites, devPost, openSection, setStatistics, signIn } from './devTraffic';

/**
 * Website traffic statistics (E109) against the DevHost, the real server core: two sites on its
 * pretend nginx, statistics turned on in the Traffic settings, a week of visits written to one
 * site's access log by the DevHost, and the report with its figures, chart, breakdowns and countries,
 * other ranges and buckets, the site picker, the site's own Traffic tab, and statistics off again.
 */

test.skip(!dotnetAvailable(), 'needs the .NET SDK to build the server core DevHost');

const BLOG = 'blog.example.com';
const SHOP = 'shop.example.com';
/** The id the site editor suggests from the first domain. */
const BLOG_ID = 'blog-example-com';
const SHOP_ID = 'shop-example-com';

let devHost: DevHost | undefined;
let launched: LaunchedApp | undefined;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  devHost = await startDevHost();
});

test.afterAll(() => {
  devHost?.stop();
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test('counts a site’s visits and shows the report, its ranges, sites and the site tab', async () => {
  test.setTimeout(300_000);
  if (!devHost) throw new Error('DevHost did not start');
  launched = await launchApp({
    settings: {},
    env: { RUNOVA_DEPLOY_DEV_CORE: String(devHost.port) },
  });
  const { page } = launched;
  await signIn(page);
  await addSites(page, [BLOG, SHOP]);

  // Statistics start off; an Owner turns them on in the Traffic settings.
  await openSection(page, 'Traffic');
  await expect(page.getByText('Traffic statistics are off', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await setStatistics(page, true);
  const filters = page.getByRole('toolbar', { name: 'Report filters' });
  await expect(filters).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('No visits yet')).toBeVisible({ timeout: 30_000 });

  // A week of visits to the blog, and a few to the shop, read by the core at once.
  const blog = await devPost<{ lines: number }>(devHost.port, '/dev/sites/traffic', {
    siteId: BLOG_ID,
    count: 600,
    daysBack: 7,
    seed: 1,
  });
  expect(blog.lines).toBe(600);
  await devPost(devHost.port, '/dev/sites/traffic', {
    siteId: SHOP_ID,
    count: 120,
    daysBack: 3,
    seed: 2,
  });

  // A range not read yet asks the core for a new report.
  await filters.getByRole('radio', { name: '30 days' }).click();
  const visits = page.getByRole('group', { name: 'Visits', exact: true });
  await expect(visits).toContainText(/[1-9]/, { timeout: 30_000 });
  await expect(page.getByRole('group', { name: 'Unique visitors' })).toContainText('about');
  await expect(page.getByRole('group', { name: 'Page views' })).toContainText(/[1-9]/);
  await expect(
    page.getByRole('img', { name: /Visitors and page views, \d+ buckets/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Pages', exact: true }).getByRole('listitem').first(),
  ).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Browsers' }).getByRole('listitem').first(),
  ).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Countries' }).getByRole('listitem').first(),
  ).toBeVisible();
  await expect(page.getByRole('img', { name: /World map of page views/ })).toBeVisible();
  await expect(page.getByText(/% from Cloudflare/).first()).toBeVisible();
  await expect(page.getByRole('img', { name: /^Devices: / })).toBeVisible();

  // "See all" pages through a breakdown from the core.
  await page
    .getByRole('heading', { name: 'Pages', exact: true })
    .locator('xpath=ancestor::section[1]')
    .getByRole('button', { name: 'See all' })
    .click();
  const all = page.getByRole('dialog', { name: 'Pages' });
  await expect(all.getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });
  await all.getByRole('button', { name: 'Close' }).click();

  // Other ranges pick their buckets: hours for today, days for a week, weeks offered for 30 days.
  await filters.getByRole('radio', { name: 'Today' }).click();
  await expect(filters.getByRole('radio', { name: 'Hour', exact: true })).toBeChecked();
  await filters.getByRole('radio', { name: '7 days' }).click();
  await expect(filters.getByRole('radio', { name: 'Day', exact: true })).toBeChecked();
  await expect(filters.getByRole('radio', { name: 'Week', exact: true })).toBeDisabled();
  await filters.getByRole('radio', { name: '30 days' }).click();
  await filters.getByRole('radio', { name: 'Week', exact: true }).click();
  await expect(filters.getByRole('radio', { name: 'Week', exact: true })).toBeChecked();
  await expect(visits).toContainText(/[1-9]/, { timeout: 30_000 });

  // One site at a time.
  await filters.getByRole('combobox', { name: 'Website' }).click();
  await page.getByRole('option', { name: SHOP }).click();
  await expect(filters.getByRole('combobox', { name: 'Website' })).toContainText(SHOP);
  await expect(visits).toContainText(/[1-9]/, { timeout: 30_000 });

  // The blog's own Traffic tab shows its report and leads to the section.
  await openSection(page, 'Websites');
  await page.getByRole('button', { name: `Edit ${BLOG}` }).click();
  await page.getByRole('tab', { name: 'Traffic' }).click();
  await expect(page.getByRole('group', { name: 'Visits', exact: true })).toContainText(/[1-9]/, {
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Open in Traffic' }).click();
  await expect(page.getByRole('combobox', { name: 'Website' })).toContainText(BLOG, {
    timeout: 30_000,
  });

  // Off again: the report gives way to the switch, and the figures are kept for later.
  await setStatistics(page, false);
  await expect(page.getByText('Traffic statistics are off', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
});
