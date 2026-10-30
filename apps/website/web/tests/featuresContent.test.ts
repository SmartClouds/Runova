import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FEATURE_GROUP_IDS } from '../src/lib/features';
import {
  featureEntryFiles,
  helpArticleNames,
  screenshotReferences,
} from './helpers/featureEntries';
import { readmeFeatureNames, specFeatureRows } from './helpers/featureSpec';
import { scanHtml } from './helpers/textScan';

interface ManifestEntry {
  name: string;
  alt: string;
}

const manifest: ManifestEntry[] = JSON.parse(
  readFileSync(new URL('../src/assets/screenshots/manifest.json', import.meta.url), 'utf8'),
);

const rows = specFeatureRows();
const entries = featureEntryFiles();
const entry = (slug: string) => entries.find((file) => file.slug === slug);

describe('feature coverage', () => {
  it('reads the twelve feature groups from the spec', () => {
    expect(rows.map((row) => row.slug)).toEqual([
      'workspace',
      'git-and-review',
      'tests',
      'relay',
      'token-usage',
      'projects',
      'build',
      'agents',
      'ship',
      'connect',
      'studio',
      'more',
    ]);
  });

  it('maps every feature in the README Features section to exactly one spec row', () => {
    const names = readmeFeatureNames();
    expect(names.length).toBeGreaterThan(40);
    for (const name of names) {
      const owners = rows.filter((row) => row.covers.includes(name)).map((row) => row.slug);
      expect(owners, name).toHaveLength(1);
    }
    const covered = rows.flatMap((row) => row.covers);
    expect(covered.filter((name) => !names.includes(name))).toEqual([]);
  });

  it.each(rows)('has a features entry for $slug with its title and README features', (row) => {
    const file = entry(row.slug);
    expect(file, `src/content/features/${row.slug}.mdx`).toBeDefined();
    expect(file?.module.frontmatter.title).toBe(row.title);
    expect(file?.module.frontmatter.covers ?? []).toEqual(row.covers);
  });

  it('has no entry outside the spec table', () => {
    const slugs = rows.map((row) => row.slug);
    expect(entries.map((file) => file.slug).filter((slug) => !slugs.includes(slug))).toEqual([]);
  });

  it('puts every entry in a filter group, with a unique order', () => {
    for (const file of entries) {
      expect(FEATURE_GROUP_IDS, file.slug).toContain(file.module.frontmatter.group);
    }
    const orders = entries.map((file) => file.module.frontmatter.order);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe('feature screenshots', () => {
  it.each(rows)('shows every screenshot the spec lists for $slug', (row) => {
    const shown = screenshotReferences(entry(row.slug)?.source ?? '');
    for (const name of row.screenshots) expect(shown, `${row.slug} shows ${name}`).toContain(name);
  });

  it('resolves every screenshot reference to a manifest entry with alt text', () => {
    for (const file of entries) {
      const names = [file.module.frontmatter.cover, ...screenshotReferences(file.source)];
      for (const name of names) {
        const shot = manifest.find((item) => item.name === name);
        expect(shot, `${file.slug} uses ${name}`).toBeDefined();
        expect(shot?.alt.trim().length ?? 0, `alt text of ${name}`).toBeGreaterThan(20);
      }
    }
  });

  it('uses no image in MDX other than a manifest screenshot', () => {
    for (const file of entries) {
      expect(file.source, file.slug).not.toMatch(/!\[|<img\b|<Image\b|<Picture\b/);
    }
  });
});

describe('feature copy', () => {
  it('links every entry to help articles that exist', () => {
    const articles = helpArticleNames();
    expect(articles).toContain('workspace');
    for (const file of entries) {
      expect(file.module.frontmatter.help.length, file.slug).toBeGreaterThan(0);
      for (const name of file.module.frontmatter.help) {
        expect(articles, `${file.slug} links /help/${name}`).toContain(name);
      }
    }
  });

  it('gives every entry a unique title and a unique description of 70 to 160 characters', () => {
    const titles = entries.map((file) => file.module.frontmatter.title);
    const descriptions = entries.map((file) => file.module.frontmatter.description);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    for (const description of descriptions) {
      expect(description.length, description).toBeGreaterThanOrEqual(70);
      expect(description.length, description).toBeLessThanOrEqual(160);
    }
  });

  it('never names a mobile version of Runova and never uses an em dash in the source', () => {
    for (const file of entries) {
      expect(scanHtml(`<p>${file.source}</p>`), file.slug).toEqual([]);
    }
  });
});
