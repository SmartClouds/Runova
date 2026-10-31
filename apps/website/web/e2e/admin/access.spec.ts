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

// Pages that need an Admin; an Editor gets a 403 page in their place.
const ADMIN_PAGES = [
  '/admin/api-clients',
  '/admin/api-clients/new',
  '/admin/api-clients/1',
  '/admin/users',
  '/admin/users/new',
  '/admin/users/1',
];

const ADMIN_MENU = ['API clients', 'Users', 'Jobs'];

test.describe('signed out', () => {
  test.use({ storageState: SIGNED_OUT });

  for (const path of [...PRIVATE_PAGES, ...ADMIN_PAGES]) {
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

  test('the set-password page opens without a session and is noindex', async ({ page }) => {
    const response = await page.goto('/admin/set-password');
    expect(response?.status()).toBe(200);
    expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
    await expect(page.getByRole('heading', { level: 1, name: 'Set your password' })).toBeVisible();
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

  test('an Editor sees no menu entry or card for the Admin pages', async ({ page }) => {
    await page.goto('/admin');
    const menu = page.getByRole('navigation', { name: 'Admin' });
    await expect(menu.getByRole('link')).toHaveText(['News', 'Blog']);
    for (const label of ADMIN_MENU) {
      await expect(page.getByRole('link', { name: label, exact: true })).toHaveCount(0);
    }
  });

  for (const path of ADMIN_PAGES) {
    test(`${path} answers an Editor with a 403 page`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(403);
      expect(response?.headers()['cache-control']).toBe('private, no-store');
      await expect(
        page.getByRole('heading', { level: 1, name: 'This page is for Admins only' }),
      ).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      const menu = page.getByRole('navigation', { name: 'Admin' });
      await expect(menu.getByRole('link')).toHaveText(['News', 'Blog']);
    });
  }

  test('the jobs dashboard refuses an Editor', async ({ request }) => {
    const response = await request.get('/hangfire', { maxRedirects: 0 });
    expect(response.status()).toBe(403);
  });

  test('sign-in sends a signed-in visitor on to the overview', async ({ page, editor }) => {
    await page.goto('/admin/sign-in');
    await expect(page).toHaveURL(/\/admin$/);
    await expect(
      page.getByRole('heading', { level: 1, name: `Hello, ${editor.displayName}` }),
    ).toBeVisible();
  });
});

test.describe('signed in as an Admin', () => {
  test.use({ storageState: async ({ adminSession }, use) => use(adminSession) });

  for (const path of ADMIN_PAGES) {
    test(`${path} renders with noindex and no-store`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
      expect(response?.headers()['cache-control']).toBe('private, no-store');
    });
  }

  test('the menu leads to every Admin page, the jobs dashboard included', async ({ page }) => {
    await page.goto('/admin');
    const menu = page.getByRole('navigation', { name: 'Admin' });
    await expect(menu.getByRole('link')).toHaveText(['News', 'Blog', ...ADMIN_MENU]);
    await menu.getByRole('link', { name: 'Jobs' }).click();
    await expect(page).toHaveURL(/\/hangfire\/?$/);
    await expect(page).toHaveTitle(/Runova jobs/);
  });
});
