import { loadRenderers } from 'astro:container';
import { getContainerRenderer as reactRenderer } from '@astrojs/react/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatSize, kindLabel } from '../src/lib/download/assets';
import { BUILD_VERSION, GITHUB_RELEASES_URL, type ReleaseAsset } from '../src/lib/download/release';
import Download from '../src/pages/download.astro';
import {
  deadApiUrl,
  FAKE_RELEASE,
  type FakeReleaseApi,
  startFakeReleaseApi,
} from './helpers/fakeReleaseApi';
import { scanHtml } from './helpers/textScan';

const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const BOT = 'Mozilla/5.0 (compatible; ExampleBot/1.0)';

const assets = FAKE_RELEASE.assets as ReleaseAsset[];

let container: AstroContainer;
let api: FakeReleaseApi;
let unavailable: FakeReleaseApi;

beforeAll(async () => {
  const renderers = await loadRenderers([reactRenderer()]);
  container = await AstroContainer.create({
    renderers,
    astroConfig: { site: 'https://runovahq.com' },
  });
  api = await startFakeReleaseApi();
  unavailable = await startFakeReleaseApi({ status: 503 });
});

afterAll(async () => {
  await api?.close();
  await unavailable?.close();
});

interface Rendered {
  response: Response;
  html: string;
}

/** Renders /download for a visitor, with the API at `apiUrl` (the page reads it per request). */
async function render(apiUrl: string, headers: Record<string, string> = {}): Promise<Rendered> {
  process.env.WEBSITE_API_INTERNAL_URL = apiUrl;
  const response = await container.renderToResponse(Download, {
    request: new Request('https://runovahq.com/download', { headers }),
  });
  return { response, html: await response.text() };
}

function section(html: string, id: string): string {
  const start = html.search(new RegExp(`<section[^>]* id="${id}"`));
  if (start < 0) return '';
  return html.slice(start, html.indexOf('</section>', start));
}

function primaryLinks(html: string): Array<{ asset: string; href: string; text: string }> {
  return [...html.matchAll(/<a\b([^>]*\bdata-primary-download\b[^>]*)>([\s\S]*?)<\/a>/g)].map(
    (match) => ({
      asset: / data-asset="([^"]*)"/.exec(match[1])?.[1] ?? '',
      href: / href="([^"]*)"/.exec(match[1])?.[1] ?? '',
      text: match[2]
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    }),
  );
}

function shownVersion(html: string): string {
  return /<[^>]+ data-version[^>]*>([^<]*)</.exec(html)?.[1]?.trim() ?? '';
}

function softwareApplication(html: string): Record<string, unknown> | undefined {
  const script = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  const graph: Array<Record<string, unknown>> = JSON.parse(script ?? '{}')['@graph'] ?? [];
  return graph.find((node) => node['@type'] === 'SoftwareApplication');
}

describe('download page with the API', () => {
  let page: Rendered;

  beforeAll(async () => {
    page = await render(api.url, { 'user-agent': WINDOWS });
  });

  it('answers 200 with the 5-minute cache and varies by the system signals', () => {
    const { headers, status } = page.response;
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toBe('public, max-age=300, stale-while-revalidate=600');
    const vary = (headers.get('vary') ?? '').toLowerCase();
    for (const name of [
      'user-agent',
      'sec-ch-ua-platform',
      'sec-ch-ua-arch',
      'sec-ch-ua-bitness',
    ]) {
      expect(vary).toContain(name);
    }
  });

  it('asks the browser for the platform, arch and bitness hints', () => {
    const acceptCh = (page.response.headers.get('accept-ch') ?? '').toLowerCase();
    for (const name of ['sec-ch-ua-platform', 'sec-ch-ua-arch', 'sec-ch-ua-bitness']) {
      expect(acceptCh).toContain(name);
    }
    expect(page.response.headers.get('critical-ch')?.toLowerCase()).toContain('sec-ch-ua-arch');
  });

  it('read the release from the API', () => {
    expect(api.requests).toContain('/api/v1/releases/latest');
  });

  it('has a title, a description of 70 to 160 characters and one h1', () => {
    expect(page.html).toContain('<title>Download | Runova</title>');
    const description = /<meta name="description" content="([^"]*)"/.exec(page.html)?.[1] ?? '';
    expect(description.length).toBeGreaterThanOrEqual(70);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(page.html.match(/<h1[\s>]/g)).toHaveLength(1);
  });

  it('shows the version from the API, its date and the release notes link', () => {
    expect(shownVersion(page.html)).toBe('2.2.0');
    expect(page.html).toContain('October 30, 2026');
    expect(page.html).toMatch(
      new RegExp(
        `<a[^>]* href="${FAKE_RELEASE.notesUrl.replace(/\./g, '\\.')}"[^>]*>[^<]*release notes`,
        'i',
      ),
    );
  });

  it('makes the Windows installer the main button', () => {
    const links = primaryLinks(section(page.html, 'get'));
    expect(links).toHaveLength(1);
    expect(links[0].asset).toBe('Runova-Setup-2.2.0.exe');
    expect(links[0].href).toBe(assets[0].downloadUrl);
    expect(links[0].text).toContain('Download for Windows');
  });

  it('lists every build with its size, checksum and file type', () => {
    const list = section(page.html, 'all-downloads');
    for (const item of assets) {
      const row = new RegExp(
        `<tr[^>]* data-asset="${item.name.replace(/\./g, '\\.')}"[\\s\\S]*?</tr>`,
      ).exec(list)?.[0];
      expect(row, item.name).toBeTruthy();
      expect(row).toContain(`href="${item.downloadUrl}"`);
      expect(row).toContain(formatSize(item.size));
      expect(row).toContain(item.sha256);
      expect(row).toContain(kindLabel(item.kind));
    }
  });

  it('shows the winget command and the system requirements', () => {
    expect(section(page.html, 'winget')).toContain('winget install SmartClouds.Runova');
    const requirements = section(page.html, 'requirements');
    expect(requirements).toContain('Windows 10');
    expect(requirements).toContain('macOS');
    expect(requirements).toContain('Linux');
  });

  it('says nothing about phones', () => {
    expect(page.html).not.toMatch(/android|iphone|\bios\b|app store|google play|\bmobile\b/i);
  });

  it('puts the shown version and the downloads in the SoftwareApplication JSON-LD', () => {
    const app = softwareApplication(page.html);
    expect(app).toMatchObject({
      name: 'Runova',
      softwareVersion: shownVersion(page.html),
      operatingSystem: 'Windows, macOS, Linux',
      releaseNotes: FAKE_RELEASE.notesUrl,
    });
    expect(app?.downloadUrl).toEqual(assets.map((item) => item.downloadUrl));
  });

  it('passes the forbidden phrase and em dash scan', () => {
    expect(scanHtml(page.html)).toEqual([]);
  });
});

describe('download page for other systems', () => {
  it('gives a Mac whose arch is unknown both disk images', async () => {
    const { html } = await render(api.url, { 'user-agent': MAC_SAFARI });
    const links = primaryLinks(section(html, 'get'));
    expect(links.map((link) => link.asset)).toEqual(['Runova-2.2.0-arm64.dmg', 'Runova-2.2.0.dmg']);
    expect(links[0].text).toContain('Apple silicon');
    expect(links[1].text).toContain('Intel');
  });

  it('reads the client hints', async () => {
    const { html } = await render(api.url, {
      'user-agent': MAC_SAFARI,
      'sec-ch-ua-platform': '"macOS"',
      'sec-ch-ua-arch': '"arm"',
      'sec-ch-ua-bitness': '"64"',
    });
    expect(primaryLinks(section(html, 'get')).map((link) => link.asset)).toEqual([
      'Runova-2.2.0-arm64.dmg',
    ]);
  });

  it('gives an unknown system the full list and no main button', async () => {
    const { html } = await render(api.url, { 'user-agent': BOT });
    expect(primaryLinks(html)).toEqual([]);
    expect(section(html, 'get')).toMatch(/pick the build for your system/i);
    const rows = section(html, 'all-downloads').match(/<tr[^>]* data-asset="/g) ?? [];
    expect(rows).toHaveLength(assets.length);
  });
});

describe('download page with the API down', () => {
  it.each([
    ['cannot be reached', () => deadApiUrl()],
    ['has no release yet', async () => unavailable.url],
    ['is not configured', async () => ''],
  ])('still renders with the build-time version when the API %s', async (_name, apiUrl) => {
    const { response, html } = await render(await apiUrl(), { 'user-agent': WINDOWS });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(shownVersion(html)).toBe(BUILD_VERSION);
    expect(html).toMatch(new RegExp(`<a[^>]* href="${GITHUB_RELEASES_URL}"`));
    expect(section(html, 'winget')).toContain('winget install SmartClouds.Runova');
    expect(primaryLinks(html)).toEqual([]);
    expect(section(html, 'all-downloads')).toBe('');
    const app = softwareApplication(html);
    expect(app?.softwareVersion).toBe(BUILD_VERSION);
    expect(app?.downloadUrl).toBe(GITHUB_RELEASES_URL);
    expect(scanHtml(html)).toEqual([]);
  });
});
