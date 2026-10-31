import { expect, type Page, test } from '@playwright/test';
import { BY_SEVERITY, FIXTURE_NEWS } from '../tests/fixtures/news/items';

// The production build renders the news from the fake API in e2e/fakeApiServer.ts.

const securitySlugs = FIXTURE_NEWS.filter((item) => item.category === 'security').map(
  (item) => item.slug,
);
const highSecuritySlugs = FIXTURE_NEWS.filter(
  (item) => item.category === 'security' && item.severity === 'high',
).map((item) => item.slug);

function cards(page: Page) {
  return page.locator('[data-news-card]');
}

async function cardSlugs(page: Page): Promise<string[]> {
  return cards(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-news-card') ?? ''),
  );
}

function filters(page: Page) {
  return page.locator('form[data-news-filters]');
}

function chip(page: Page, name: string) {
  return filters(page).getByRole('checkbox', { name, exact: true });
}

test.describe('news with JavaScript', () => {
  test('applies each chip at once, keeps the filters in the URL and goes back', async ({
    page,
  }) => {
    await page.goto('/news');
    await expect(filters(page)).toHaveAttribute('data-enhanced', '');
    await expect(filters(page).getByRole('button', { name: 'Apply filters' })).toBeHidden();
    await expect(cards(page)).toHaveCount(20);

    await chip(page, 'Security').check();
    await expect(page).toHaveURL('/news?category=security');
    await expect.poll(() => cardSlugs(page)).toEqual(securitySlugs);

    await chip(page, 'High').check();
    await expect(page).toHaveURL('/news?category=security&severity=high');
    await expect.poll(() => cardSlugs(page)).toEqual(highSecuritySlugs);
    await expect(page.locator('[data-news-count]')).toHaveText(
      `${highSecuritySlugs.length} ${highSecuritySlugs.length === 1 ? 'item matches' : 'items match'} these filters`,
    );

    await page.goBack();
    await expect(page).toHaveURL('/news?category=security');
    await expect.poll(() => cardSlugs(page)).toEqual(securitySlugs);
    await expect(chip(page, 'High')).not.toBeChecked();
    await expect(chip(page, 'Security')).toBeChecked();

    await filters(page).getByRole('link', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL('/news');
    await expect(cards(page)).toHaveCount(20);
    await expect(chip(page, 'Security')).not.toBeChecked();
  });

  test('opens a filtered link with its chips checked', async ({ page }) => {
    await page.goto('/news?severity=high&category=security');
    await expect(chip(page, 'Security')).toBeChecked();
    await expect(chip(page, 'High')).toBeChecked();
    expect(await cardSlugs(page)).toEqual(highSecuritySlugs);
  });

  test('goes from a card to its item page and back to the news', async ({ page }) => {
    const item = BY_SEVERITY.critical;
    await page.goto('/news');
    await page.getByRole('link', { name: item.title }).click();
    await expect(page).toHaveURL(`/news/${item.slug}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(item.title);
    await expect(page.getByRole('heading', { name: 'What to do' })).toBeVisible();
    await page.getByRole('main').getByRole('link', { name: 'News', exact: true }).click();
    await expect(page).toHaveURL('/news');
  });

  test('fits a 320px wide phone without scrolling sideways', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    for (const path of [
      '/news',
      `/news/${BY_SEVERITY.high.slug}`,
      `/news/${BY_SEVERITY.info.slug}`,
    ]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBe(0);
    }
  });

  test('the footer links to the news', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Footer' })
      .getByRole('link', { name: 'News' })
      .click();
    await expect(page).toHaveURL('/news');
  });

  test('serves the feed and the news sitemap', async ({ request }) => {
    const feed = await request.get('/news/rss.xml');
    expect(feed.status()).toBe(200);
    expect(await feed.text()).toContain(`/news/${FIXTURE_NEWS[0].slug}</link>`);

    const sitemap = await request.get('/news-sitemap.xml');
    expect(sitemap.status()).toBe(200);
    expect(await sitemap.text()).toContain('<news:publication_date>');
  });
});

test.describe('news without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('filters with the Apply button and keeps the filters in the URL', async ({ page }) => {
    await page.goto('/news');
    const apply = filters(page).getByRole('button', { name: 'Apply filters' });
    await expect(apply).toBeVisible();

    await chip(page, 'Security').check();
    await chip(page, 'High').check();
    await apply.click();
    await expect(page).toHaveURL('/news?category=security&severity=high');
    expect(await cardSlugs(page)).toEqual(highSecuritySlugs);
    await expect(chip(page, 'Security')).toBeChecked();
    await expect(chip(page, 'High')).toBeChecked();

    await chip(page, 'High').uncheck();
    await apply.click();
    await expect(page).toHaveURL('/news?category=security');
    expect(await cardSlugs(page)).toEqual(securitySlugs);

    await filters(page).getByRole('link', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL('/news');
    await expect(cards(page)).toHaveCount(20);
  });
});
