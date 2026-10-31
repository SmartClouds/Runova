import { expect, type Page, test } from '@playwright/test';
import { FIXTURE_POSTS } from '../tests/fixtures/blog/posts';

// The production build renders the blog from the fake API in e2e/fakeApiServer.ts.

function cards(page: Page) {
  return page.locator('[data-post-card]');
}

function pager(page: Page) {
  return page.getByRole('navigation', { name: 'Pagination' });
}

test.describe('blog', () => {
  // The fixture covers point at the real site's media, which a test must not wait on.
  test.beforeEach(async ({ page }) => {
    await page.route('https://runovahq.com/media/**', (route) => route.fulfill({ status: 404 }));
  });

  test('pages through every post, newest first', async ({ page }) => {
    await page.goto('/blog');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Blog');
    await expect(cards(page)).toHaveCount(10);
    await expect(cards(page).first()).toHaveAttribute('data-post-card', FIXTURE_POSTS[0].slug);

    await pager(page).getByRole('link', { name: 'Older posts' }).click();
    await expect(page).toHaveURL('/blog/page/2');
    await expect(pager(page)).toContainText('Page 2 of 3');
    await expect(cards(page).first()).toHaveAttribute('data-post-card', FIXTURE_POSTS[10].slug);

    await pager(page).getByRole('link', { name: 'Older posts' }).click();
    await expect(page).toHaveURL('/blog/page/3');
    await expect(cards(page)).toHaveCount(3);
    await expect(pager(page).getByRole('link', { name: 'Older posts' })).toHaveCount(0);

    await pager(page).getByRole('link', { name: 'Newer posts' }).click();
    await pager(page).getByRole('link', { name: 'Newer posts' }).click();
    await expect(page).toHaveURL('/blog');
  });

  test('fits a 320px wide phone without scrolling sideways', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    for (const path of ['/blog/page/2', `/blog/${FIXTURE_POSTS[0].slug}`]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBe(0);
    }
  });

  test('sends /blog/page/1 to /blog', async ({ page }) => {
    const response = await page.goto('/blog/page/1');
    expect(response?.url()).toMatch(/\/blog$/);
    await expect(cards(page)).toHaveCount(10);
  });

  test('goes from a post to its tag and back to a post', async ({ page }) => {
    const post = FIXTURE_POSTS[0];
    await page.goto('/blog');
    await page.getByRole('link', { name: post.title }).click();
    await expect(page).toHaveURL(`/blog/${post.slug}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(post.title);
    await expect(page.getByText('6 min read')).toBeVisible();

    await page
      .getByRole('main')
      .getByRole('list', { name: 'Tags' })
      .first()
      .getByRole('link', { name: 'Relay' })
      .click();
    await expect(page).toHaveURL('/blog/tags/relay');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Posts tagged Relay');
    await expect(cards(page)).toHaveCount(2);

    await page.getByRole('link', { name: FIXTURE_POSTS[2].title }).click();
    await expect(page).toHaveURL(`/blog/${FIXTURE_POSTS[2].slug}`);
  });

  test('pages a tag with more than one page of posts', async ({ page }) => {
    await page.goto('/blog/tags/release-notes');
    await expect(cards(page)).toHaveCount(10);
    await pager(page).getByRole('link', { name: 'Older posts' }).click();
    await expect(page).toHaveURL('/blog/tags/release-notes/page/2');
    await expect(cards(page)).toHaveCount(10);
    await expect(cards(page).last()).toHaveAttribute('data-post-card', FIXTURE_POSTS[22].slug);
  });

  test('answers an unknown post with the 404 page', async ({ page }) => {
    const response = await page.goto('/blog/no-such-post');
    expect(response?.status()).toBe(404);
    expect(response?.headers()['cache-control']).toBe('no-store');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
  });

  test('serves the feed and a title card for a post without a cover', async ({ request }) => {
    const feed = await request.get('/blog/rss.xml');
    expect(feed.status()).toBe(200);
    expect(feed.headers()['content-type']).toBe('application/rss+xml; charset=utf-8');
    expect(await feed.text()).toContain(`<link>http`);

    const image = await request.get(`/blog/${FIXTURE_POSTS[1].slug}/og.png`);
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toBe('image/png');
  });

  test('the footer links to the blog', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Footer' })
      .getByRole('link', { name: 'Blog' })
      .click();
    await expect(page).toHaveURL('/blog');
  });
});
