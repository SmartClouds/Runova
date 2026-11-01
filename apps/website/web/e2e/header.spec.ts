import { expect, type Page, test } from '@playwright/test';
import { FIXTURE_NEWS } from '../tests/fixtures/news/items';

const main = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const panel = (page: Page, id: string) => page.locator(`#mega-${id}`);

const newestNews = [...FIXTURE_NEWS]
  .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
  .slice(0, 3);

test.describe('header menu', () => {
  test('shows the three newest news items when News is hovered', async ({ page }) => {
    await page.goto('/features');
    await main(page).getByRole('link', { name: 'News' }).hover();
    const news = panel(page, 'news');
    await expect(news).toBeVisible();
    await expect(main(page).getByRole('link', { name: 'News', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const links = news.locator('.mp-body a');
    await expect(links).toHaveCount(3);
    expect(await links.evaluateAll((all) => all.map((link) => link.getAttribute('href')))).toEqual(
      newestNews.map((item) => `/news/${item.slug}`),
    );
    await expect(links.first()).toContainText('Latest');
  });

  test('moves the open panel to the label the pointer moves to, then closes off the menu', async ({
    page,
  }) => {
    await page.goto('/features');
    await main(page).getByRole('link', { name: 'News' }).hover();
    await expect(panel(page, 'news')).toBeVisible();
    await main(page).getByRole('link', { name: 'Blog' }).hover();
    await expect(panel(page, 'blog')).toBeVisible();
    await expect(panel(page, 'news')).toBeHidden();
    await page.mouse.move(10, 600);
    await expect(panel(page, 'blog')).toBeHidden();
  });

  test('opens from the keyboard and closes with Escape back on the label', async ({ page }) => {
    await page.goto('/features');
    const resources = main(page).getByRole('button', { name: 'Resources' });
    await resources.focus();
    await page.keyboard.press('ArrowDown');
    await expect(panel(page, 'resources')).toBeVisible();
    await expect(panel(page, 'resources').getByRole('link', { name: /Download/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel(page, 'resources')).toBeHidden();
    await expect(resources).toBeFocused();
  });

  test('still goes to the section page when a label is clicked', async ({ page }) => {
    await page.goto('/');
    await main(page).getByRole('link', { name: 'News' }).click();
    await expect(page).toHaveURL(/\/news$/);
  });

  test('opens the systems from the Download button, sliding over from the menu', async ({
    page,
  }) => {
    await page.goto('/features');
    await main(page).getByRole('link', { name: 'Help', exact: true }).hover();
    const download = page.locator('header [data-beam-source]');
    await download.hover();
    const systems = panel(page, 'download');
    await expect(systems).toBeVisible();
    await expect(download).toHaveAttribute('aria-expanded', 'true');
    await expect(systems.locator('.mp-grid a')).toHaveText([
      /Windows/,
      /macOS, Apple silicon/,
      /macOS, Intel/,
      /Linux/,
    ]);
    // The panel stays inside the window, though the button is near its right edge.
    const box = await systems.boundingBox();
    const width = page.viewportSize()?.width ?? 0;
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 16 + 0.5);
    await main(page).getByRole('button', { name: 'Resources' }).hover();
    await expect(panel(page, 'resources')).toBeVisible();
    await expect(systems).toBeHidden();
  });

  test('still goes to /download when the Download button is clicked', async ({ page }) => {
    await page.goto('/features');
    await page.locator('header [data-beam-source]').click();
    await expect(page).toHaveURL(/\/download$/);
  });

  test('moves into a sheet on a phone, which opens, fills and closes', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/features');
    await expect(main(page)).toBeHidden();
    const button = page.getByRole('button', { name: 'Open menu' });
    await button.click();
    const sheet = page.getByRole('navigation', { name: 'Site menu' });
    await expect(sheet).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close menu' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(sheet.locator('[data-latest="news"] a')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(button).toBeFocused();
  });
});
