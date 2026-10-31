import { type APIResponse, expect, type Page, test } from '@playwright/test';
import { SECURITY_HEADERS } from '../src/lib/security';
import { FIXTURE_POSTS } from '../tests/fixtures/blog/posts';
import { FIXTURE_NEWS } from '../tests/fixtures/news/items';

// The production server sends the security headers on every response and the CSP on every page,
// and nothing the site does trips the CSP.

function expectSecurityHeaders(response: APIResponse, what: string) {
  const headers = response.headers();
  for (const [name, value] of SECURITY_HEADERS) {
    expect(headers[name.toLowerCase()], `${what} ${name}`).toBe(value);
  }
}

function expectCsp(response: APIResponse, what: string) {
  const csp = response.headers()['content-security-policy'] ?? '';
  expect(csp, what).toContain("default-src 'self'");
  expect(csp, what).toContain("frame-ancestors 'none'");
  expect(csp, what).toContain("object-src 'none'");
  const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? '';
  expect(scriptSrc, what).toMatch(/'sha256-/);
  expect(scriptSrc, what).not.toContain("'unsafe-inline'");
  expect(scriptSrc, what).not.toContain("'unsafe-eval'");
}

test.describe('response headers', () => {
  const post = FIXTURE_POSTS[0].slug;
  const item = FIXTURE_NEWS[0].slug;
  const pages = ['/', '/features/relay', '/help/relay', '/download', '/blog', `/blog/${post}`];
  pages.push('/news', `/news/${item}`, '/admin/sign-in');

  for (const path of pages) {
    test(`${path} carries the CSP and the security headers`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expectSecurityHeaders(response, path);
      expectCsp(response, path);
    });
  }

  test('static files carry the security headers too', async ({ request }) => {
    const home = await (await request.get('/')).text();
    const asset = /["'(](\/_astro\/[^"')]+\.(?:js|css))["')]/.exec(home)?.[1];
    expect(asset).toBeTruthy();
    for (const path of [asset as string, '/robots.txt', '/sitemap-index.xml', '/favicon-32.png']) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expectSecurityHeaders(response, path);
    }
  });

  test('a missing page answers 404, never cached, with the headers', async ({ request }) => {
    const response = await request.get('/no-such-page');
    expect(response.status()).toBe(404);
    expect(response.headers()['cache-control']).toBe('no-store');
    expectSecurityHeaders(response, '404');
    expectCsp(response, '404');
    expect(await response.text()).toContain('Page not found');
  });
});

/** Collects CSP violations from the page's events and from the console. */
async function watchCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction('__reportCspViolation', (line: string) => violations.push(line));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as { __reportCspViolation(line: string): void })
        .__reportCspViolation;
      report(`${event.violatedDirective} blocked ${event.blockedURI.slice(0, 80) || 'inline'}`);
    });
  });
  page.on('console', (message) => {
    // Shortened: a blocked data URL fills the whole message.
    if (/Content.Security.Policy/i.test(message.text()))
      violations.push(message.text().slice(0, 300));
  });
  return violations;
}

test.describe('under the CSP', () => {
  test.beforeEach(async ({ page }) => {
    // The fixture covers point at the real site's media, which a test must not wait on.
    await page.route('https://runovahq.com/media/**', (route) => route.fulfill({ status: 404 }));
  });

  test('the home page runs the hero and the theme toggle', async ({ page }) => {
    const violations = await watchCsp(page);
    await page.goto('/');
    await expect(page.locator('[data-hero]')).toHaveAttribute('data-state', /running|static/, {
      timeout: 15_000,
    });
    await page.getByRole('button', { name: /theme/i }).first().click();
    await page.waitForLoadState('networkidle');
    expect(violations).toEqual([]);
  });

  test('the features grid filters', async ({ page }) => {
    const violations = await watchCsp(page);
    await page.goto('/features');
    await page.getByRole('group').getByRole('button').nth(1).click();
    await page.waitForLoadState('networkidle');
    expect(violations).toEqual([]);
  });

  test('the help search runs Pagefind', async ({ page }) => {
    const violations = await watchCsp(page);
    await page.goto('/help');
    await page.locator('[data-help-search][data-ready]').waitFor();
    await page.getByRole('searchbox').fill('worktree');
    await expect(page.locator('[data-help-search-results] a').first()).toBeVisible();
    expect(violations).toEqual([]);
  });

  test('the news filters swap the results', async ({ page }) => {
    const violations = await watchCsp(page);
    await page.goto('/news');
    await expect(page.locator('form[data-news-filters]')).toHaveAttribute('data-enhanced', '');
    await page.getByRole('checkbox', { name: 'Security', exact: true }).check();
    await expect(page).toHaveURL(/category=security/);
    await page.waitForLoadState('networkidle');
    expect(violations).toEqual([]);
  });

  for (const path of [
    '/features/ship',
    '/help/relay',
    '/download',
    '/blog',
    `/blog/${FIXTURE_POSTS[0].slug}`,
    `/news/${FIXTURE_NEWS[0].slug}`,
    '/no-such-page',
    '/admin/sign-in',
  ]) {
    test(`${path} loads with no CSP violation`, async ({ page }) => {
      const violations = await watchCsp(page);
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(violations).toEqual([]);
    });
  }
});
