import { loadRenderers } from 'astro:container';
import { readFileSync } from 'node:fs';
import { getContainerRenderer as mdxRenderer } from '@astrojs/mdx/container-renderer';
import { getContainerRenderer as reactRenderer } from '@astrojs/react/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import FeatureLayout from '../src/layouts/FeatureLayout.astro';
import { featureEntryFiles } from './helpers/featureEntries';
import { scanHtml } from './helpers/textScan';

interface ManifestEntry {
  name: string;
  alt: string;
}

const manifest: ManifestEntry[] = JSON.parse(
  readFileSync(new URL('../src/assets/screenshots/manifest.json', import.meta.url), 'utf8'),
);

const entries = featureEntryFiles();
const pages = new Map<string, string>();

beforeAll(async () => {
  // React draws the header icons, MDX the entry body.
  const renderers = await loadRenderers([reactRenderer(), mdxRenderer()]);
  const container = await AstroContainer.create({
    renderers,
    astroConfig: { site: 'https://runovahq.com' },
  });
  for (const { slug, module } of entries) {
    const html = await container.renderToString(FeatureLayout, {
      props: { slug, data: module.frontmatter, Content: module.default },
      request: new Request(`https://runovahq.com/features/${slug}`),
    });
    pages.set(slug, html);
  }
});

function decode(value: string): string {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function jsonLdNodes(html: string): Array<Record<string, unknown>> {
  const script = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  return JSON.parse(script ?? '{}')['@graph'] ?? [];
}

describe.each(entries)('the $slug feature page', ({ slug, module }) => {
  const data = module.frontmatter;
  const html = () => pages.get(slug) ?? '';

  it('uses the entry title and description in the head', () => {
    expect(decode(/<title>([^<]*)<\/title>/.exec(html())?.[1] ?? '')).toBe(
      `${data.title} | Runova`,
    );
    expect(decode(/<meta name="description" content="([^"]*)"/.exec(html())?.[1] ?? '')).toBe(
      data.description,
    );
    expect(html()).toContain(`<link rel="canonical" href="https://runovahq.com/features/${slug}">`);
  });

  it('has one h1 with the title', () => {
    expect(html().match(/<h1[\s>]/g)).toHaveLength(1);
    expect(decode(/<h1[^>]*>([^<]*)<\/h1>/.exec(html())?.[1] ?? '')).toBe(data.title);
  });

  it('shows breadcrumbs and describes them as a BreadcrumbList', () => {
    expect(html()).toMatch(/<nav[^>]* aria-label="Breadcrumb"/);
    const crumbs = jsonLdNodes(html()).find((node) => node['@type'] === 'BreadcrumbList');
    expect(crumbs?.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://runovahq.com/' },
      { '@type': 'ListItem', position: 2, name: 'Features', item: 'https://runovahq.com/features' },
      {
        '@type': 'ListItem',
        position: 3,
        name: data.title,
        item: `https://runovahq.com/features/${slug}`,
      },
    ]);
  });

  it('shows its screenshots with the alt text from the manifest', () => {
    const images = html().match(/<img[^>]*>/g) ?? [];
    const alts = images.map((img) => decode(/ alt="([^"]*)"/.exec(img)?.[1] ?? ''));
    const shots = alts.filter((alt) => manifest.some((shot) => shot.alt === alt));
    expect(shots.length).toBeGreaterThan(0);
    // Every other image (the header logo) is decorative and says so with an empty alt.
    for (const img of images) expect(img).toMatch(/ alt="/);
  });

  it('links its help articles', () => {
    for (const name of data.help)
      expect(html()).toMatch(new RegExp(`<a[^>]* href="/help/${name}"`));
  });

  it('passes the forbidden-phrase and em dash scan', () => {
    expect(scanHtml(html())).toEqual([]);
  });
});

describe('feature pages together', () => {
  it('have unique titles and descriptions', () => {
    const titles = [...pages.values()].map((html) => /<title>([^<]*)</.exec(html)?.[1]);
    const descriptions = [...pages.values()].map(
      (html) => /<meta name="description" content="([^"]*)"/.exec(html)?.[1],
    );
    expect(new Set(titles).size).toBe(entries.length);
    expect(new Set(descriptions).size).toBe(entries.length);
  });
});
