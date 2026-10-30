import { loadRenderers } from 'astro:container';
import { readFileSync } from 'node:fs';
import { getContainerRenderer as reactRenderer } from '@astrojs/react/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADE_POINTS, AGENT_CLIS, HIGHLIGHTS } from '../src/lib/home';
import { HOME_TITLE } from '../src/lib/seo';
import Home from '../src/pages/index.astro';
import { scanHtml } from './helpers/textScan';

interface ManifestEntry {
  name: string;
  alt: string;
}

const manifest: ManifestEntry[] = JSON.parse(
  readFileSync(new URL('../src/assets/screenshots/manifest.json', import.meta.url), 'utf8'),
);

let html: string;

beforeAll(async () => {
  const renderers = await loadRenderers([reactRenderer()]);
  const container = await AstroContainer.create({
    renderers,
    astroConfig: { site: 'https://runovahq.com' },
  });
  html = await container.renderToString(Home, {
    request: new Request('https://runovahq.com/'),
  });
});

/** The markup of the element that opens with `<tag ... id="id"` up to its closing tag. */
function section(id: string): string {
  const start = html.search(new RegExp(`<section[^>]* id="${id}"`));
  if (start < 0) return '';
  return html.slice(start, html.indexOf('</section>', start));
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function jsonLdNodes(): Array<Record<string, unknown>> {
  const script = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  return JSON.parse(script ?? '{}')['@graph'] ?? [];
}

describe('home page', () => {
  it('uses the home title and a description of 70 to 160 characters', () => {
    expect(html).toContain(`<title>${HOME_TITLE}</title>`);
    const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(description.length).toBeGreaterThanOrEqual(70);
    expect(description.length).toBeLessThanOrEqual(160);
  });

  it('has exactly one h1, in the hero', () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(section('hero')).toMatch(/<h1[^>]*>[^<]*Run the work/);
  });

  it('shows the static hero image in the server render, with a host for the scene', () => {
    const hero = section('hero');
    expect(hero).toMatch(
      /<svg[^>]* data-hero-fallback[^>]* role="img"[^>]* aria-label="[^"]{10,}"/,
    );
    expect(hero).toMatch(/<div[^>]* data-hero-scene[^>]* aria-hidden="true"/);
  });

  it('hydrates no framework island, so React stays off the page', () => {
    expect(html).not.toContain('<astro-island');
  });

  it('sends visitors to /download from the hero and from the closing call to action', () => {
    expect(section('hero')).toMatch(/<a[^>]* href="\/download"/);
    expect(section('download')).toMatch(/<a[^>]* href="\/download"/);
  });

  it('explains what an ADE is, point by point', () => {
    const ade = section('ade');
    expect(ade).toMatch(/<h2[^>]*>/);
    expect(ade).toContain('An IDE is built around a person typing code.');
    for (const point of ADE_POINTS) expect(ade).toContain(point.title);
  });

  it('lists the agent CLIs it works with as plain text', () => {
    const agents = section('agents');
    for (const cli of AGENT_CLIS) expect(agents).toContain(`>${cli}<`);
  });

  describe('feature highlights', () => {
    it('has a section per highlight with its heading and a link to its features page', () => {
      const features = section('features');
      expect(HIGHLIGHTS.length).toBeGreaterThanOrEqual(4);
      for (const highlight of HIGHLIGHTS) {
        expect(features).toContain(highlight.title);
        expect(features).toContain(`href="/features/${highlight.slug}"`);
      }
    });

    it('shows a real screenshot for each highlight as AVIF and WebP, sized and lazy', () => {
      const features = section('features');
      const pictures = features.match(/<picture[\s\S]*?<\/picture>/g) ?? [];
      expect(pictures).toHaveLength(HIGHLIGHTS.length);
      pictures.forEach((picture, index) => {
        const shot = HIGHLIGHTS[index].shot;
        expect(picture).toMatch(/<source[^>]* type="image\/avif"/);
        expect(picture).toMatch(/<source[^>]* type="image\/webp"/);
        const img = /<img[^>]*>/.exec(picture)?.[0] ?? '';
        expect(img).toMatch(/ width="\d+"/);
        expect(img).toMatch(/ height="\d+"/);
        expect(img).toContain('loading="lazy"');
        const alt = manifest.find((entry) => entry.name === shot)?.alt;
        expect(alt, `manifest entry for ${shot}`).toBeTruthy();
        const shown = / alt="([^"]*)"/.exec(img)?.[1] ?? '';
        expect(decodeAttribute(shown)).toBe(alt);
      });
    });
  });

  describe('JSON-LD', () => {
    it('has the Organization', () => {
      const organization = jsonLdNodes().find((node) => node['@type'] === 'Organization');
      expect(organization).toMatchObject({ name: 'Runova', url: 'https://runovahq.com/' });
    });

    it('describes Runova as a free SoftwareApplication for the three desktop systems', () => {
      const app = jsonLdNodes().find((node) => node['@type'] === 'SoftwareApplication');
      expect(app).toMatchObject({
        name: 'Runova',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Windows, macOS, Linux',
        url: 'https://runovahq.com/',
        downloadUrl: 'https://runovahq.com/download',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        publisher: { '@id': 'https://runovahq.com/#organization' },
      });
      expect(String(app?.description).length).toBeGreaterThan(50);
      expect(String(app?.image)).toMatch(/^https:\/\/runovahq\.com\//);
    });
  });

  it('passes the forbidden phrase and em dash scan', () => {
    expect(scanHtml(html)).toEqual([]);
  });
});
