import { expect, SIGNED_OUT, test } from './fixtures';

// Pages that need a session; sign-in is the one admin page anyone can open.
const PRIVATE_PAGES = [
  '/admin',
  '/admin/news',
  '/admin/news/new',
  '/admin/news/1',
  '/admin/blog',
  '/admin/blog/new',
  '/admin/blog/1',
];

test.describe('signed out', () => {
  test.use({ storageState: SIGNED_OUT });

  for (const path of PRIVATE_PAGES) {
    test(`${path} redirects to sign-in and comes back after`, async ({ request }) => {
      const response = await request.get(`${path}?view=1`, { maxRedirects: 0 });
      expect(response.status()).toBe(302);
      expect(response.headers().location).toBe(
        `/admin/sign-in?next=${encodeURIComponent(`${path}?view=1`)}`,
      );
      expect(response.headers()['x-robots-tag']).toBe('noindex, nofollow');
      expect(response.headers()['cache-control']).toBe('private, no-store');
    });
  }

  test('the sign-in page is noindex', async ({ page }) => {
    const response = await page.goto('/admin/sign-in');
    expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    );
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  });

  test('no admin page is in the sitemap', async ({ request }) => {
    const index = await (await request.get('/sitemap-index.xml')).text();
    const sitemaps = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(sitemaps.length).toBeGreaterThan(0);
    for (const sitemap of sitemaps) {
      const body = await (await request.get(new URL(sitemap).pathname)).text();
      expect(body).toContain('<urlset');
      expect(body).not.toMatch(/\/admin(?:[/<?]|$)/);
    }
  });
});

test.describe('signed in', () => {
  for (const path of PRIVATE_PAGES) {
    test(`${path} renders with noindex and no-store`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
      expect(response?.headers()['cache-control']).toBe('private, no-store');
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        'content',
        'noindex, nofollow',
      );
      await expect(page.getByRole('navigation', { name: 'Admin' })).toBeVisible();
    });
  }

  test('sign-in sends a signed-in visitor on to the overview', async ({ page, editor }) => {
    await page.goto('/admin/sign-in');
    await expect(page).toHaveURL(/\/admin$/);
    await expect(
      page.getByRole('heading', { level: 1, name: `Hello, ${editor.displayName}` }),
    ).toBeVisible();
  });
});
