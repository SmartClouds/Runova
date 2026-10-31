import type { Locator, Page } from '@playwright/test';
import sharp from 'sharp';
import { expect, test, uniqueTitle } from './fixtures';

const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

async function save(page: Page, adminPath: string) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
  await expect(page).toHaveURL(new RegExp(`${adminPath}/\\d+$`));
}

/** Waits until the image has really loaded, not just until its element shows. */
const expectLoaded = (image: Locator) =>
  expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth),
    )
    .toBeGreaterThan(0);

/** A `datetime-local` value a day from now, in the browser's time zone. */
const tomorrow = (page: Page) =>
  page.evaluate(() => {
    const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  });

test('an Editor publishes a security advisory, sees it on /news, then edits it', async ({
  page,
}) => {
  const title = uniqueTitle('Advisory');
  await page.goto('/admin/news');
  await page.getByRole('link', { name: 'New news item' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New news item' })).toBeVisible();

  await page.getByLabel('Title').fill(title);
  await expect(page.getByLabel('Slug')).toHaveValue(slugOf(title));
  await page.getByLabel('Summary').fill('A flaw in the parser lets a crafted file run code.');
  await page.getByLabel('Category').selectOption({ label: 'Security' });
  await page.getByLabel('CVSS score').fill('8.1');
  await page.getByRole('button', { name: 'Use High' }).click();
  await expect(page.getByLabel('Severity')).toHaveValue('high');
  await page.getByLabel('CVE ids').fill('cve-2026-12345');

  // The picker is fed by /api/v1/technologies.
  const picker = page.getByLabel('Technology to add');
  await picker.selectOption({ index: 1 });
  const technology = (await picker.locator('option:checked').textContent()) ?? '';
  await page.getByRole('button', { name: 'Add technology' }).click();
  await page.getByLabel(`Affected versions of ${technology}`).fill('<2.0.0');
  await page.getByLabel(`Fixed in for ${technology}`).fill('2.0.0');

  await page.getByLabel('Body (Markdown)').fill('## What to do\n\nUpdate to **2.0.0** today.');
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview.getByRole('heading', { level: 2, name: 'What to do' })).toBeVisible();
  await expect(preview.locator('strong')).toHaveText('2.0.0');

  await page.getByRole('radio', { name: 'Publish now' }).check();
  await save(page, '/admin/news');
  const editUrl = page.url();

  await page.goto('/news');
  await expect(page.getByRole('link', { name: title })).toBeVisible();
  await page.goto(`/news/${slugOf(title)}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page.getByText('CVE-2026-12345').first()).toBeVisible();
  await expect(page.getByText(technology).first()).toBeVisible();

  await page.goto(editUrl);
  await expect(page.getByLabel('Title')).toHaveValue(title);
  await expect(page.getByLabel('Slug')).toHaveValue(slugOf(title));
  await page.getByLabel('Title').fill(`${title} (updated)`);
  await save(page, '/admin/news');

  // The item page is cacheable, so the browser would show its first copy without the query.
  await page.goto(`/news/${slugOf(title)}?after-edit`);
  await expect(page.getByRole('heading', { level: 1, name: `${title} (updated)` })).toBeVisible();
});

test('an Editor publishes a post with a cover and tags, and it shows on /blog', async ({
  page,
}) => {
  const title = uniqueTitle('Post');
  const cover = await sharp({
    create: { width: 1200, height: 630, channels: 3, background: '#3a5bd9' },
  })
    .png()
    .toBuffer();

  await page.goto('/admin/blog');
  await page.getByRole('link', { name: 'New post' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Excerpt').fill('How the workspace view got faster.');
  await page.getByLabel('Tags').fill('performance, workspaces');
  await page.getByLabel('Body (Markdown)').fill('The view now opens in **half** the time.');

  await page.getByLabel('Cover image file').setInputFiles({
    name: 'cover.png',
    mimeType: 'image/png',
    buffer: cover,
  });
  await page.getByLabel('Alt text').fill('A blue field');
  await page.getByRole('button', { name: 'Upload cover' }).click();
  await expectLoaded(page.getByRole('img', { name: 'A blue field' }));

  await page.getByRole('radio', { name: 'Publish now' }).check();
  await save(page, '/admin/blog');

  await page.goto('/blog');
  await expect(page.getByRole('link', { name: title }).first()).toBeVisible();
  await page.goto(`/blog/${slugOf(title)}`);
  // Related posts from earlier runs can show the same cover, so look in this post's own article.
  const article = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { level: 1, name: title }) });
  await expectLoaded(article.getByRole('img', { name: 'A blue field' }));
  await expect(page.getByRole('link', { name: 'performance' }).first()).toBeVisible();
});

test('a scheduled news item and post stay off the public pages', async ({ page }) => {
  const newsTitle = uniqueTitle('Scheduled news');
  await page.goto('/admin/news/new');
  await page.getByLabel('Title').fill(newsTitle);
  await page.getByLabel('Summary').fill('This one goes out tomorrow morning.');
  await page.getByLabel('Body (Markdown)').fill('Coming soon.');
  await page.getByRole('radio', { name: 'Schedule' }).check();
  await page.getByLabel('Publish at').fill(await tomorrow(page));
  await save(page, '/admin/news');

  const postTitle = uniqueTitle('Scheduled post');
  await page.goto('/admin/blog/new');
  await page.getByLabel('Title').fill(postTitle);
  await page.getByLabel('Excerpt').fill('This one goes out tomorrow morning.');
  await page.getByLabel('Body (Markdown)').fill('Coming soon.');
  await page.getByRole('radio', { name: 'Schedule' }).check();
  await page.getByLabel('Publish at').fill(await tomorrow(page));
  await save(page, '/admin/blog');

  await page.goto('/admin/news?status=scheduled');
  await expect(
    page
      .getByRole('row', { name: new RegExp(newsTitle) })
      .getByRole('cell')
      .first(),
  ).toHaveText('Scheduled');
  await page.goto('/admin/blog?status=scheduled');
  await expect(
    page
      .getByRole('row', { name: new RegExp(postTitle) })
      .getByRole('cell')
      .first(),
  ).toHaveText('Scheduled');

  await page.goto('/news');
  await expect(page.getByRole('link', { name: newsTitle })).toHaveCount(0);
  expect((await page.goto(`/news/${slugOf(newsTitle)}`))?.status()).toBe(404);
  await page.goto('/blog');
  await expect(page.getByRole('link', { name: postTitle })).toHaveCount(0);
  expect((await page.goto(`/blog/${slugOf(postTitle)}`))?.status()).toBe(404);
});
