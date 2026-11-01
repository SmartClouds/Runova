import { loadRenderers } from 'astro:container';
import { readFileSync } from 'node:fs';
import { getContainerRenderer as reactRenderer } from '@astrojs/react/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEMO_LENGTH, DEMO_PANES, statusSummary } from '../src/lib/heroDemo';
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
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
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

  describe('hero workspace demo', () => {
    it('is a figure that describes itself to screen readers and hides the visual', () => {
      const hero = section('hero');
      expect(hero).toMatch(/<figure[^>]* data-hero[\s>]/);
      expect(hero).toMatch(/<figure[^>]* data-state="idle"/);
      const caption = /<figcaption class="sr-only"[^>]*>([\s\S]*?)<\/figcaption>/.exec(hero)?.[1];
      expect(caption?.trim().length).toBeGreaterThanOrEqual(10);
      expect(hero).toMatch(/<div class="demo-window"[^>]* aria-hidden="true"/);
    });

    it('renders the finished run, so it reads right without JavaScript', () => {
      const hero = decodeAttribute(section('hero'));
      for (const pane of DEMO_PANES) {
        expect(hero).toContain(`>${pane.cli}<`);
        for (const line of pane.lines) expect(hero).toContain(line.text);
        if (pane.status) {
          expect(hero).toContain(`data-status="${pane.status.end}"`);
          expect(hero).toContain(`--end-at: ${pane.status.endAt}`);
        }
      }
      expect(hero).toContain(`>${statusSummary(DEMO_LENGTH)}<`);
    });

    it('gives every line its moment in the run', () => {
      const lines = section('hero').match(/<p class="demo-line[^"]*"[^>]*>/g) ?? [];
      expect(lines).toHaveLength(DEMO_PANES.flatMap((pane) => pane.lines).length);
      for (const line of lines) expect(line).toMatch(/style="--at: [\d.]+"/);
    });
  });

  describe('hero demo status bar', () => {
    it('counts agents by status as the run goes', () => {
      expect(statusSummary(0)).toBe('3 working');
      expect(statusSummary(3)).toBe('2 working · 1 waiting on you');
      expect(statusSummary(DEMO_LENGTH)).toBe('1 waiting on you · 2 done');
    });
  });

  it('hydrates no framework island, so React stays off the page', () => {
    expect(html).not.toContain('<astro-island');
  });

  it('leaves the download and GitHub buttons to the header, not the hero', () => {
    const hero = section('hero');
    expect(hero).not.toContain('data-download-split');
    expect(hero).not.toMatch(/<a[^>]* href="\/download"/);
    expect(hero).not.toContain('github.com');
  });

  describe('split download button', () => {
    it('is in the closing call to action', () => {
      expect(section('download')).toMatch(/<a[^>]* href="\/download"/);
      expect(section('download')).toContain('data-download-split');
    });

    it('offers every desktop system in a menu that starts closed', () => {
      const cta = section('download');
      expect(cta).toMatch(
        /<button[^>]* aria-haspopup="menu" aria-expanded="false" aria-controls="cta-download-menu"/,
      );
      expect(cta).toMatch(/<div[^>]* id="cta-download-menu" role="menu"[^>]* hidden/);
      for (const os of ['windows', 'macos', 'linux']) {
        expect(cta).toMatch(new RegExp(`role="menuitem" href="/download/${os}/latest"`));
      }
    });
  });

  it("lets the beam fall from the header's Download button", () => {
    const header = /<header[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
    expect(header).toMatch(/<a[^>]* href="\/download"[^>]* data-beam-source/);
    expect(html.match(/data-beam-source/g)).toHaveLength(1);
  });

  it('has a canvas for the beam that screen readers skip', () => {
    expect(section('hero')).toMatch(
      /<div class="hero-beam[^"]*" aria-hidden="true" data-beam-stage[^>]*><canvas/,
    );
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
