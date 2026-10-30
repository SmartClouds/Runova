import { expect, type Page, test } from '@playwright/test';
import { FAKE_RELEASE } from '../tests/helpers/fakeReleaseApi';
import { scanHtml } from '../tests/helpers/textScan';

const UA = {
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  linux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  bot: 'Mozilla/5.0 (compatible; ExampleBot/1.0)',
};

interface Emulated {
  userAgent: string;
  /** The client hint values Chromium reports: Sec-CH-UA-Platform, -Arch and -Bitness. */
  platform: string;
  arch: string;
}

/**
 * Makes the page's browser present itself as another system, client hints included. Playwright's
 * userAgent option alone keeps the host's hints whenever it cannot derive them from the string.
 * Chromium sends only the platform at first; the page's Critical-CH makes it retry with the arch.
 */
async function emulate(page: Page, system: Emulated) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: system.userAgent,
    userAgentMetadata: {
      platform: system.platform,
      platformVersion: '',
      architecture: system.arch,
      bitness: '64',
      model: '',
      mobile: false,
    },
  });
}

const systems = [
  {
    name: 'Windows x64',
    userAgent: UA.windows,
    platform: 'Windows',
    arch: 'x86',
    asset: 'Runova-Setup-2.2.0.exe',
  },
  {
    name: 'macOS arm64',
    userAgent: UA.mac,
    platform: 'macOS',
    arch: 'arm',
    asset: 'Runova-2.2.0-arm64.dmg',
  },
  {
    name: 'macOS x64',
    userAgent: UA.mac,
    platform: 'macOS',
    arch: 'x86',
    asset: 'Runova-2.2.0.dmg',
  },
  {
    name: 'Linux x64',
    userAgent: UA.linux,
    platform: 'Linux',
    arch: 'x86',
    asset: 'Runova-2.2.0.AppImage',
  },
];

const primary = (page: Page) => page.locator('[data-primary-download]');
const rows = (page: Page) => page.locator('#all-downloads tbody tr');

for (const system of systems) {
  test(`${system.name} gets the matching build as the main button`, async ({ page }) => {
    await emulate(page, system);
    await page.goto('/download');
    await expect(primary(page)).toHaveCount(1);
    const expected = FAKE_RELEASE.assets.find(
      (asset: { name: string }) => asset.name === system.asset,
    );
    await expect(primary(page)).toHaveAttribute('data-asset', system.asset);
    await expect(primary(page)).toHaveAttribute('href', expected.downloadUrl);
    await expect(rows(page)).toHaveCount(FAKE_RELEASE.assets.length);
  });
}

test('an unknown system gets the full list with no main button', async ({ page }) => {
  await emulate(page, { userAgent: UA.bot, platform: 'Unknown', arch: '' });
  await page.goto('/download');
  await expect(page.getByText('Pick the build for your system')).toBeVisible();
  await expect(primary(page)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(FAKE_RELEASE.assets.length);
});

test.describe('download page', () => {
  test.use({ userAgent: UA.windows });

  test('is rendered on demand with the 5-minute cache and the client hint headers', async ({
    request,
  }) => {
    const response = await request.get('/download');
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers['cache-control']).toBe('public, max-age=300, stale-while-revalidate=600');
    expect(headers['accept-ch']).toContain('Sec-CH-UA-Arch');
    expect(headers.vary).toContain('User-Agent');
  });

  test('shows the version from the API in the page and the JSON-LD', async ({ page }) => {
    await page.goto('/download');
    const shown = (await page.locator('[data-version]').textContent())?.trim();
    expect(shown).toBe(FAKE_RELEASE.version);
    const ld = await page.locator('script[type="application/ld+json"]').textContent();
    const graph: Array<Record<string, unknown>> = JSON.parse(ld ?? '{}')['@graph'] ?? [];
    const app = graph.find((node) => node['@type'] === 'SoftwareApplication');
    expect(app?.softwareVersion).toBe(shown);
    await expect(page.getByRole('link', { name: 'Read the release notes' })).toHaveAttribute(
      'href',
      FAKE_RELEASE.notesUrl,
    );
  });

  test('has the winget command and the system requirements', async ({ page }) => {
    await page.goto('/download');
    await expect(page.getByText('winget install SmartClouds.Runova')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'System requirements' })).toBeVisible();
  });

  test('has no horizontal scroll at 320px wide', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/download');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });

  test('passes the forbidden phrase and em dash scan', async ({ request }) => {
    const html = await (await request.get('/download')).text();
    expect(scanHtml(html)).toEqual([]);
  });

  test('is in the sitemap, although it has no file in the build', async ({ request }) => {
    const sitemap = await (await request.get('/sitemap-0.xml')).text();
    expect(sitemap).toMatch(/<loc>https?:\/\/[^<]+\/download<\/loc>/);
  });

  test('is reached from the home page', async ({ page }) => {
    await page.goto('/');
    await page.locator('#hero').getByRole('link', { name: 'Download Runova' }).click();
    await expect(page).toHaveURL(/\/download$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Download Runova' })).toBeVisible();
  });
});
