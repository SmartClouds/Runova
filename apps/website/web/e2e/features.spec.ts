import { expect, type Page, test } from '@playwright/test';
import { specFeatureRows } from '../tests/helpers/featureSpec';
import { scanHtml } from '../tests/helpers/textScan';

const rows = specFeatureRows();
const paths = ['/features', ...rows.map((row) => `/features/${row.slug}`)];

const cards = (page: Page) => page.locator('[data-feature-card]');
const visibleCards = (page: Page) => page.locator('[data-feature-card]:visible');
const groupButton = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Filter by group' }).getByRole('button', { name, exact: true });

async function openIndex(page: Page) {
  await page.goto('/features');
  await page.locator('[data-filter-controls][data-ready]').waitFor();
}

test.describe('built features pages', () => {
  test('every page has a unique title and description and a BreadcrumbList', async ({
    request,
  }) => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();
    for (const path of paths) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      const html = await response.text();
      titles.add(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '');
      const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
      expect(description.length, path).toBeGreaterThanOrEqual(70);
      expect(description.length, path).toBeLessThanOrEqual(160);
      descriptions.add(description);
      const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
      const graph: Array<Record<string, unknown>> = JSON.parse(ld ?? '{}')['@graph'] ?? [];
      const crumbs = graph.find((node) => node['@type'] === 'BreadcrumbList');
      const items = (crumbs?.itemListElement ?? []) as Array<{ item: string }>;
      expect(items.at(-1)?.item, path).toBe(new URL(path, 'https://runovahq.com').href);
    }
    expect(titles.size).toBe(paths.length);
    expect(descriptions.size).toBe(paths.length);
  });

  test('every page passes the forbidden-phrase and em dash scan', async ({ request }) => {
    for (const path of paths) {
      const response = await request.get(path);
      expect(scanHtml(await response.text()), path).toEqual([]);
    }
  });

  test('every image on every page has an alt attribute', async ({ page }) => {
    for (const path of paths) {
      await page.goto(path);
      const missing = await page.locator('img:not([alt])').count();
      expect(missing, path).toBe(0);
    }
  });

  test('the breadcrumbs lead back to the index', async ({ page }) => {
    await page.goto('/features/relay');
    const nav = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(nav.getByRole('link')).toHaveText(['Home', 'Features']);
    await nav.getByRole('link', { name: 'Features' }).click();
    await expect(page).toHaveURL(/\/features$/);
  });

  test('has no horizontal scroll at 320px wide', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    for (const path of ['/features', '/features/ship']) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });
});

test.describe('features index filter', () => {
  test('shows every feature at first, with All pressed', async ({ page }) => {
    await openIndex(page);
    await expect(visibleCards(page)).toHaveCount(rows.length);
    await expect(groupButton(page, 'All')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a group toggle shows only that group and announces the count', async ({ page }) => {
    await openIndex(page);
    await groupButton(page, 'Connect').click();
    await expect(groupButton(page, 'Connect')).toHaveAttribute('aria-pressed', 'true');
    await expect(groupButton(page, 'All')).toHaveAttribute('aria-pressed', 'false');
    await expect(visibleCards(page)).toHaveCount(1);
    await expect(visibleCards(page)).toContainText('Connect');
    await expect(page.locator('[data-filter-status]')).toHaveText(
      `Showing 1 of ${rows.length} features`,
    );

    await groupButton(page, 'All').click();
    await expect(visibleCards(page)).toHaveCount(rows.length);
  });

  test('the search finds a feature by a name inside its group', async ({ page }) => {
    await openIndex(page);
    await page.getByLabel('Search features').fill('docker');
    await expect(visibleCards(page)).toHaveCount(1);
    await expect(visibleCards(page).getByRole('link')).toHaveAttribute('href', '/features/ship');
  });

  test('says so when nothing matches, and clearing brings everything back', async ({ page }) => {
    await openIndex(page);
    await page.getByLabel('Search features').fill('no such feature here');
    await expect(visibleCards(page)).toHaveCount(0);
    await expect(page.getByText('No feature matches')).toBeVisible();
    await page.getByRole('button', { name: 'Clear the filter' }).click();
    await expect(visibleCards(page)).toHaveCount(rows.length);
    await expect(page.getByLabel('Search features')).toHaveValue('');
  });

  test('without JavaScript, every card is there and the controls stay hidden', async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/features');
    await expect(visibleCards(page)).toHaveCount(rows.length);
    await expect(page.locator('[data-filter-controls]')).toBeHidden();
    await expect(cards(page)).toHaveCount(rows.length);
    await context.close();
  });

  test('the header links to the features index', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Features' })
      .click();
    await expect(page).toHaveURL(/\/features$/);
  });
});
