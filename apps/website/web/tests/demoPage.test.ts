import { loadRenderers } from 'astro:container';
import { readFileSync } from 'node:fs';
import { getContainerRenderer as reactRenderer } from '@astrojs/react/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import { sitemapOptions } from '../astro.config.mjs';
import { qrPath } from '../src/lib/qr';
import Demo from '../src/pages/demo.astro';
import { scanHtml } from './helpers/textScan';

/**
 * The demo page (/demo). The Runova app signs into its demo account when it scans a code that
 * holds exactly this page's address, so the code on the page must be that address and nothing
 * else. Someone who scans it with the phone's own camera lands here, so the page also says how to
 * do it from the app.
 */

const DEMO_URL = 'https://runovahq.com/demo';

let html: string;

beforeAll(async () => {
  const renderers = await loadRenderers([reactRenderer()]);
  const container = await AstroContainer.create({
    renderers,
    astroConfig: { site: 'https://runovahq.com' },
  });
  html = await container.renderToString(Demo, { request: new Request(DEMO_URL) });
});

const text = () =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

const qrSvg = () => /<svg[^>]* role="img"[^>]*>[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';

describe('demo page head', () => {
  it('has its own title, a description of 70 to 160 characters and a canonical on the site', () => {
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('<title>Try the demo | Runova</title>');
    const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(description.length).toBeGreaterThanOrEqual(70);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(html).toContain(`<link rel="canonical" href="${DEMO_URL}"`);
  });

  it('is built once, open to search engines and in the sitemap', () => {
    const source = readFileSync(new URL('../src/pages/demo.astro', import.meta.url), 'utf8');
    expect(source).toMatch(/export const prerender = true/);
    expect(html).not.toContain('noindex');
    expect(sitemapOptions.filter?.(DEMO_URL)).toBe(true);
  });
});

describe('demo page content', () => {
  it('has one h1 that invites a visitor to try the app', () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1]).toMatch(/Try the Runova app/);
  });

  it('says it is a demo with made-up data where nothing is saved', () => {
    const words = text();
    expect(words).toMatch(/made-up/);
    expect(words).toMatch(/nothing you do is saved/i);
  });

  it('draws a QR code that holds exactly the page address', () => {
    const svg = qrSvg();
    expect(svg).toMatch(/ aria-label="[^"]*QR code[^"]*"/);
    const d = /<path[^>]* d="([^"]*)"/.exec(svg)?.[1];
    expect(d).toBe(qrPath(DEMO_URL).path);
  });

  it('keeps the code scannable: dark squares on white with a quiet zone of four modules', () => {
    const svg = qrSvg();
    const { size } = qrPath(DEMO_URL);
    expect(svg).toContain(`viewBox="-4 -4 ${size + 8} ${size + 8}"`);
    expect(svg).toMatch(/class="[^"]*\bbg-white\b/);
    expect(svg).toMatch(/<path[^>]* fill="#000"/);
  });

  it('walks through the steps in order, from the app', () => {
    const steps = /<ol[^>]* data-demo-steps[^>]*>([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? '';
    const items = [...steps.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((match) =>
      match[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(/Install the Runova app on your phone/);
    expect(items[1]).toMatch(/Scan QR code/);
    expect(items[2]).toMatch(/Point the camera at this code/);
  });

  it('shows the address as text for anyone who cannot scan', () => {
    expect(text()).toContain(DEMO_URL);
  });

  it('says the demo computer is pretend and links to the desktop download', () => {
    expect(text()).toMatch(/pretend/);
    expect(html).toContain('href="/download"');
  });

  it('links only with the link utilities', () => {
    const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    for (const tag of main.match(/<a [^>]*href="\/(?:download|help)[^"]*"[^>]*>/g) ?? []) {
      expect(tag).toMatch(/class="[^"]*\blink(?:-muted)?\b/);
    }
  });

  it('passes the site text scan: no em dash and none of the forbidden phrases', () => {
    expect(scanHtml(html)).toEqual([]);
  });
});
