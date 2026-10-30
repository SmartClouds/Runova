import { readdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

const articlesDir = new URL('../../../desktop/src/shared/help/articles/', import.meta.url);
const slugs = readdirSync(articlesDir)
  .filter((name) => name.endsWith('.md'))
  .map((name) => name.slice(0, -3))
  .sort();

async function openSearch(page: Page) {
  await page.goto('/help');
  await page.locator('[data-help-search][data-ready]').waitFor();
  return page.getByLabel('Search the help center');
}

test.describe('help pages', () => {
  test('the index links to one page per article file', async ({ page }) => {
    await page.goto('/help');
    const hrefs = await page
      .locator('[data-help-category] a')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    expect([...hrefs].sort()).toEqual(slugs.map((slug) => `/help/${slug}`));
  });

  test('every article page answers with its title as the heading', async ({ request }) => {
    for (const slug of slugs) {
      const response = await request.get(`/help/${slug}`);
      expect(response.status(), slug).toBe(200);
      const html = await response.text();
      const title = /<title>([^<]*?)(?: \| Runova)?<\/title>/.exec(html)?.[1];
      const heading = /<h1[^>]*>([^<]*)<\/h1>/.exec(html)?.[1];
      expect(heading, slug).toBeTruthy();
      expect(title, slug).toBe(heading);
    }
  });

  test('the header links to the help center', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Help' })
      .click();
    await expect(page).toHaveURL(/\/help$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Help center');
  });

  test('previous and next walk through the articles', async ({ page }) => {
    await page.goto('/help/relay');
    const more = page.getByRole('navigation', { name: 'More articles' });
    const nextTitle = await more.locator('a[rel="next"] .font-medium').textContent();
    await more.locator('a[rel="next"]').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(nextTitle ?? '');
    await page.getByRole('navigation', { name: 'More articles' }).locator('a[rel="prev"]').click();
    await expect(page).toHaveURL(/\/help\/relay$/);
  });

  test('the table of contents jumps to its section', async ({ page }) => {
    await page.goto('/help/relay');
    const toc = page.getByRole('navigation', { name: 'On this page' });
    const entry = toc.getByRole('link').nth(1);
    const target = (await entry.getAttribute('href')) ?? '';
    await entry.click();
    await expect(page).toHaveURL(new RegExp(`${target}$`));
    await expect(page.locator(target)).toBeInViewport();
  });
});

test.describe('help search', () => {
  // Words that are only in an article's front matter keywords, never in its text.
  const keywordOnly = [
    { keyword: 'kanban', slug: 'relay' },
    { keyword: 'mascot', slug: 'widgets-desktop-pet' },
  ];

  for (const { keyword, slug } of keywordOnly) {
    test(`finds ${slug} by the keyword "${keyword}"`, async ({ page }) => {
      await page.goto(`/help/${slug}`);
      const article = page.locator('article');
      await expect(article.locator('[data-keywords]')).toHaveAttribute(
        'data-keywords',
        new RegExp(`\\b${keyword}\\b`),
      );
      // biome-ignore lint/performance/useDomNodeTextContent: the text a reader sees, without the hidden keywords.
      expect((await article.innerText()).toLowerCase()).not.toContain(keyword);

      const input = await openSearch(page);
      await input.fill(keyword);
      const results = page.locator('[data-help-search-results] a');
      await expect(results.first()).toBeVisible();
      await expect(page.locator(`[data-help-search-results] a[href="/help/${slug}"]`)).toHaveCount(
        1,
      );
    });
  }

  test('a result opens its article', async ({ page }) => {
    const input = await openSearch(page);
    await input.fill('worktree');
    const first = page.locator('[data-help-search-results] a').first();
    const href = (await first.getAttribute('href')) ?? '';
    expect(href).toMatch(/^\/help\/[\w-]+$/);
    await first.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  });

  test('says so when nothing matches', async ({ page }) => {
    const input = await openSearch(page);
    await input.fill('qwxzv');
    await expect(page.locator('[data-help-search-status]')).toHaveText(
      'No article matches "qwxzv".',
    );
    await expect(page.locator('[data-help-search-results] li')).toHaveCount(0);
  });

  test('without JavaScript the box stays hidden and the list is complete', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/help');
    await expect(page.locator('[data-help-search]')).toBeHidden();
    await expect(page.locator('[data-help-category] a')).toHaveCount(slugs.length);
    await context.close();
  });
});
