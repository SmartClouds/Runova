import { describe, expect, it } from 'vitest';
import config, { sitemapOptions } from '../astro.config.mjs';
import { llmsTxt } from '../src/lib/llms';
import { robotsTxt } from '../src/lib/robots';
import { featureEntryFiles } from './helpers/featureEntries';
import { scanHtml } from './helpers/textScan';

const SITE = 'https://runovahq.com';

const features = featureEntryFiles()
  .map(({ slug, module }) => ({ slug, ...module.frontmatter }))
  .sort((a, b) => a.order - b.order);

describe('robots.txt', () => {
  const lines = robotsTxt(SITE).split('\n');

  it('lets every crawler in except to /admin, /api and the jobs dashboard', () => {
    expect(lines[0]).toBe('User-agent: *');
    expect(lines).toContain('Disallow: /admin');
    expect(lines).toContain('Disallow: /api/');
    expect(lines).toContain('Disallow: /hangfire');
    expect(lines.filter((line) => line.startsWith('Disallow:'))).toHaveLength(3);
  });

  it('points at the sitemap index and the news sitemap with absolute URLs', () => {
    expect(lines).toContain(`Sitemap: ${SITE}/sitemap-index.xml`);
    expect(lines).toContain(`Sitemap: ${SITE}/news-sitemap.xml`);
  });

  it('has only directives robots.txt parsers know', () => {
    for (const line of lines.filter(Boolean)) {
      expect(line).toMatch(/^(User-agent|Disallow|Allow|Sitemap): \S+$/);
    }
  });
});

describe('llms.txt', () => {
  const text = llmsTxt(SITE, features);
  const links = [...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map((match) => match[2]);

  it('starts with the name and a one-line summary in a quote', () => {
    const [title, blank, summary] = text.split('\n');
    expect(title).toBe('# Runova');
    expect(blank).toBe('');
    expect(summary).toMatch(/^> .{40,}$/);
  });

  it('links every feature page with its description', () => {
    for (const feature of features) {
      expect(text).toContain(`- [${feature.title}](${SITE}/features/${feature.slug}): `);
    }
  });

  it('links the main pages with absolute URLs on the site', () => {
    for (const path of ['/features', '/help', '/download', '/blog', '/news']) {
      expect(links).toContain(`${SITE}${path}`);
    }
    for (const link of links) expect(link.startsWith(`${SITE}/`)).toBe(true);
  });

  it('has its sections as h2 headings', () => {
    const headings = text.split('\n').filter((line) => line.startsWith('#'));
    expect(headings[0]).toBe('# Runova');
    expect(headings.slice(1).every((heading) => heading.startsWith('## '))).toBe(true);
  });

  it('passes the site text scan', () => {
    expect(scanHtml(text)).toEqual([]);
  });
});

describe('sitemap index', () => {
  it('lists the dynamic sitemap and the news sitemap next to the static one', () => {
    const integration = config.integrations?.find(
      (each) =>
        each && typeof each === 'object' && 'name' in each && each.name === '@astrojs/sitemap',
    );
    expect(integration).toBeDefined();
    const site = config.site ?? SITE;
    expect(sitemapOptions.customSitemaps).toEqual([
      new URL('/sitemap-dynamic.xml', site).href,
      new URL('/news-sitemap.xml', site).href,
    ]);
  });
});
